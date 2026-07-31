import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GuildQueue, Track } from '../src/types/index.js';

const testDataDir = join(tmpdir(), `lolbot-now-playing-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;

let queueManager: any;
let nowPlayingManager: any;
let guildSettingsManager: any;
let stopCommand: typeof import('../src/commands/stop.js');

function currentTrack(id: string): Track {
    return {
        id,
        provider: 'youtube',
        sourceId: id,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
        title: `Track ${id}`,
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: 180,
        thumbnail: '',
        requestedBy: 'Tester',
        requestedById: '200000000000000001',
    };
}

function createQueue(
    guildId: string,
    edit: () => Promise<unknown>,
    deleteMessage: () => Promise<unknown> = async () => undefined
): GuildQueue {
    const queue = {
        guildId,
        textChannel: { send: async () => undefined },
        voiceChannel: { id: `voice-${guildId}` },
        connection: null,
        player: null,
        tracks: [],
        currentTrack: currentTrack(guildId),
        isPlaying: true,
        isPaused: false,
        isStopping: false,
        volume: 100,
        nowPlayingMessage: { edit, delete: deleteMessage },
        lyricsMessages: [],
        lyricsTrackId: null,
        startedAt: Date.now() - 10_000,
        pausedAt: null,
        totalPausedTime: 0,
        autoPausedByEmptyChannel: false,
        isReconnecting: false,
        reconnectAttempts: 0,
        shouldKeepConnection: true,
        isManualDisconnect: false,
        lastStartMetrics: null,
    } as unknown as GuildQueue;
    queueManager.queues.set(guildId, queue);
    return queue;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(predicate(), true, 'condition asynchrone non atteinte avant le délai du test');
}

function resetManager(): void {
    for (const timer of nowPlayingManager.updateIntervals.values()) clearInterval(timer);
    for (const timer of nowPlayingManager.retryTimers.values()) clearTimeout(timer);
    nowPlayingManager.updateIntervals.clear();
    nowPlayingManager.retryTimers.clear();
    nowPlayingManager.retryAttempts.clear();
    nowPlayingManager.pendingUpdates.clear();
    nowPlayingManager.nowPlayingDeletes.clear();
    nowPlayingManager.retryBaseDelayMs = 1_000;
    nowPlayingManager.retryMaxDelayMs = 30_000;
    nowPlayingManager.retryJitterMs = 250;
    queueManager.queues.clear();
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    ({ queueManager } = await import('../src/services/QueueManager.js'));
    ({ nowPlayingManager } = await import('../src/services/NowPlayingManager.js'));
    ({ guildSettingsManager } = await import('../src/services/GuildSettingsManager.js'));
    stopCommand = await import('../src/commands/stop.js');
    const { config } = await import('../src/config.js');
    config.audio.ephemeralInfoDeleteDelay = 1;
});

afterEach(async () => {
    await waitFor(() => nowPlayingManager.updatesInFlight === 0);
    resetManager();
});

after(async () => {
    resetManager();
    await rm(testDataDir, { recursive: true, force: true });
});

test('periodic updates stay suppressed while a Now Playing retry backoff is active', async () => {
    nowPlayingManager.retryBaseDelayMs = 60;
    nowPlayingManager.retryMaxDelayMs = 60;
    nowPlayingManager.retryJitterMs = 0;
    let editCalls = 0;
    const queue = createQueue('guild-now-playing-backoff', async () => {
        editCalls += 1;
        throw new Error('temporary Discord failure');
    });

    nowPlayingManager.scheduleUpdate(queue);
    await waitFor(() => nowPlayingManager.retryTimers.has(queue.guildId));
    assert.equal(editCalls, 1);

    for (let index = 0; index < 5; index += 1) {
        nowPlayingManager.scheduleUpdate(queue);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(editCalls, 1, 'les ticks périodiques ne doivent pas contourner le backoff');

    await waitFor(() => editCalls === 2);
});

test('permanent Discord errors disable updates without scheduling retries', async () => {
    let editCalls = 0;
    const queue = createQueue('guild-now-playing-permanent', async () => {
        editCalls += 1;
        throw { code: 50013, status: 403 };
    });

    nowPlayingManager.scheduleUpdate(queue);
    await waitFor(() => editCalls === 1 && nowPlayingManager.updatesInFlight === 0);

    assert.equal(queue.nowPlayingMessage, null);
    assert.equal(nowPlayingManager.retryTimers.has(queue.guildId), false);
    assert.equal(nowPlayingManager.retryAttempts.has(queue.guildId), false);
});

test('transient Now Playing failures stop after five bounded retries', async () => {
    nowPlayingManager.retryBaseDelayMs = 1;
    nowPlayingManager.retryMaxDelayMs = 1;
    nowPlayingManager.retryJitterMs = 0;
    let editCalls = 0;
    const queue = createQueue('guild-now-playing-retry-cap', async () => {
        editCalls += 1;
        throw new Error('temporary Discord failure');
    });

    nowPlayingManager.scheduleUpdate(queue);
    await waitFor(() => queue.nowPlayingMessage === null, 1_000);

    assert.equal(editCalls, 6, 'un essai initial et cinq retries sont autorisés');
    assert.equal(nowPlayingManager.retryTimers.has(queue.guildId), false);
    assert.equal(nowPlayingManager.retryAttempts.has(queue.guildId), false);
});

test('concurrent Now Playing cleanup deletes one Discord message and awaits the same operation', async () => {
    let deleteCalls = 0;
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const queue = createQueue(
        'guild-now-playing-idempotent-delete',
        async () => undefined,
        async () => {
            deleteCalls += 1;
            await deleteGate;
        }
    );

    const firstDelete = nowPlayingManager.deleteNowPlaying(queue);
    const secondDelete = nowPlayingManager.deleteNowPlaying(queue);
    assert.equal(queue.nowPlayingMessage, null, 'la référence doit être retirée avant le premier await');
    assert.equal(deleteCalls, 1);

    releaseDelete();
    await Promise.all([firstDelete, secondDelete]);
    assert.equal(deleteCalls, 1);
    assert.equal(nowPlayingManager.nowPlayingDeletes.has(queue.guildId), false);
});

test('slow cleanup never deletes a replacement Now Playing message created while it waits', async () => {
    let oldDeleteCalls = 0;
    let replacementDeleteCalls = 0;
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const queue = createQueue(
        'guild-now-playing-replacement',
        async () => undefined,
        async () => {
            oldDeleteCalls += 1;
            await deleteGate;
        }
    );

    const firstDelete = nowPlayingManager.deleteNowPlaying(queue);
    const coalescedDelete = nowPlayingManager.deleteNowPlaying(queue);
    const replacementMessage = {
        edit: async () => undefined,
        delete: async () => { replacementDeleteCalls += 1; },
    };
    queue.nowPlayingMessage = replacementMessage as never;

    releaseDelete();
    await Promise.all([firstDelete, coalescedDelete]);

    assert.equal(oldDeleteCalls, 1);
    assert.equal(replacementDeleteCalls, 0);
    assert.equal(queue.nowPlayingMessage, replacementMessage);
});

test('Now Playing identifies SoundCloud, links the canonical track, and shows the uploader', () => {
    const queue = createQueue('guild-now-playing-soundcloud', async () => undefined);
    queue.currentTrack = {
        ...currentTrack('soundcloud:2011421339'),
        provider: 'soundcloud',
        sourceId: '2011421339',
        canonicalUrl: 'https://soundcloud.com/skorxh/audio-dealer',
        url: 'https://soundcloud.com/skorxh/audio-dealer',
        title: 'Audio Dealer',
        channelTitle: '$KORCH',
    };

    const components = nowPlayingManager.createNowPlayingComponents(queue, 'fr');
    const content = String(components[0]?.components?.[0]?.content ?? '');
    assert.match(content, /\[Audio Dealer\]\(https:\/\/soundcloud\.com\/skorxh\/audio-dealer\)/);
    assert.match(content, /SoundCloud · \$KORCH/);
});

function makeStopButton(guildId: string, events: string[]) {
    const interaction: Record<string, any> = {
        customId: 'np_stop',
        guildId,
        locale: 'fr',
        deferred: false,
        replied: false,
        member: {
            user: { id: '189457295279783936', tag: 'owner' },
            voice: { channelId: `voice-${guildId}`, channel: { id: `voice-${guildId}` } },
        },
        deferReply: async () => {
            events.push('defer');
            interaction.deferred = true;
        },
        editReply: async () => { events.push('edit'); },
        followUp: async () => { events.push('followUp'); },
        reply: async () => { events.push('reply'); },
        deleteReply: async () => undefined,
    };
    return interaction;
}

async function verifyStopButtonOrder(stayConnected: boolean): Promise<void> {
    const guildId = `guild-stop-button-${stayConnected ? 'stay' : 'leave'}`;
    const events: string[] = [];
    let deleteCalls = 0;
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const queue = createQueue(
        guildId,
        async () => undefined,
        async () => {
            deleteCalls += 1;
            events.push('cleanup-start');
            await deleteGate;
            events.push('cleanup-end');
        }
    );
    const interaction = makeStopButton(guildId, events);
    const originalGetSettings = guildSettingsManager.getSettings;
    const originalStop = queueManager.stop;
    const originalDeleteQueue = queueManager.deleteQueue;
    guildSettingsManager.getSettings = async () => {
        events.push('settings');
        return {
            ...guildSettingsManager.getDefaults(guildId),
            stayConnected,
        };
    };
    queueManager.stop = (id: string) => {
        events.push('stop');
        return originalStop.call(queueManager, id);
    };
    queueManager.deleteQueue = (id: string, manual: boolean) => {
        events.push('deleteQueue');
        return originalDeleteQueue.call(queueManager, id, manual);
    };

    try {
        const handling = nowPlayingManager.handleButtonInteraction(interaction);
        await waitFor(() => events.includes('cleanup-start'));
        assert.equal(events[0], 'defer', 'Discord doit être acquitté avant les settings et le nettoyage');
        assert.equal(events.includes('edit'), false, 'la réponse finale attend le nettoyage Discord');

        releaseDelete();
        await handling;

        const action = stayConnected ? 'stop' : 'deleteQueue';
        assert.ok(events.indexOf('defer') < events.indexOf(action));
        assert.ok(events.indexOf(action) < events.indexOf('cleanup-start'));
        assert.ok(events.indexOf('cleanup-end') < events.indexOf('edit'));
        assert.equal(deleteCalls, 1);
        assert.equal(events.includes(stayConnected ? 'deleteQueue' : 'stop'), false);
        assert.equal(events.includes('reply'), false);
        assert.equal(events.includes('followUp'), false);
        assert.equal(queue.nowPlayingMessage, null);
    } finally {
        guildSettingsManager.getSettings = originalGetSettings;
        queueManager.stop = originalStop;
        queueManager.deleteQueue = originalDeleteQueue;
    }
}

test('Stop button defers, cleans once, then edits when the bot stays connected', async () => {
    await verifyStopButtonOrder(true);
});

test('Stop button defers, cleans once, then edits when the bot leaves voice', async () => {
    await verifyStopButtonOrder(false);
});

test('/stop defers before locale/settings work and waits for slow Now Playing cleanup', async () => {
    const guildId = 'guild-stop-command-order';
    const events: string[] = [];
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    createQueue(
        guildId,
        async () => undefined,
        async () => {
            events.push('cleanup-start');
            await deleteGate;
            events.push('cleanup-end');
        }
    );
    const originalGetSettings = guildSettingsManager.getSettings;
    const originalStop = queueManager.stop;
    guildSettingsManager.getSettings = async () => {
        events.push('settings');
        return {
            ...guildSettingsManager.getDefaults(guildId),
            stayConnected: true,
        };
    };
    queueManager.stop = (id: string) => {
        events.push('stop');
        return originalStop.call(queueManager, id);
    };
    const interaction: Record<string, any> = {
        inGuild: () => true,
        guildId,
        locale: 'fr',
        deferred: false,
        replied: false,
        member: {
            user: { id: '189457295279783936', tag: 'owner' },
            voice: { channelId: `voice-${guildId}`, channel: { id: `voice-${guildId}` } },
        },
        deferReply: async () => {
            events.push('defer');
            interaction.deferred = true;
        },
        editReply: async () => { events.push('edit'); },
        followUp: async () => { events.push('followUp'); },
        reply: async () => { events.push('reply'); },
        deleteReply: async () => undefined,
    };

    try {
        const handling = stopCommand.execute(interaction as never);
        await waitFor(() => events.includes('cleanup-start'));
        assert.equal(events[0], 'defer');
        assert.equal(events.includes('edit'), false);
        releaseDelete();
        await handling;
        assert.ok(events.indexOf('defer') < events.indexOf('settings'));
        assert.ok(events.indexOf('stop') < events.indexOf('cleanup-start'));
        assert.ok(events.indexOf('cleanup-end') < events.indexOf('edit'));
        assert.equal(events.includes('reply'), false);
        assert.equal(events.includes('followUp'), false);
    } finally {
        guildSettingsManager.getSettings = originalGetSettings;
        queueManager.stop = originalStop;
    }
});
