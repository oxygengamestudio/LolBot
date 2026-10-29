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
    nowPlayingManager.renders = new WeakMap();
    nowPlayingManager.renderDirty = new WeakSet();
    nowPlayingManager.generations = new WeakMap();
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

test('concurrent player refreshes coalesce without overlapping Discord edits', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const queue = createQueue('guild-coalesced', async () => {
        maximum = Math.max(maximum, ++active);
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
    });
    await Promise.all(Array.from({ length: 20 }, () => nowPlayingManager.updateNowPlaying(queue)));
    assert.equal(maximum, 1);
    assert.ok(calls <= 2);
});

test('stop during slow message creation removes the late message and leaves no timer', async () => {
    let release!: (value: unknown) => void;
    let sends = 0;
    let deletes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const queue = createQueue('guild-late-send', async () => undefined);
    queue.nowPlayingMessage = null;
    queue.textChannel.send = (async () => { sends += 1; return gate; }) as never;
    const creation = nowPlayingManager.onTrackStart(queue);
    await waitFor(() => sends === 1);
    queue.currentTrack = null;
    queue.isStopping = true;
    const deletion = nowPlayingManager.deleteNowPlaying(queue);
    const coalescedDeletion = nowPlayingManager.deleteNowPlaying(queue);
    release({ delete: async () => { deletes += 1; } });
    await Promise.all([creation, deletion, coalescedDeletion]);
    assert.equal(deletes, 1);
    assert.equal(queue.nowPlayingMessage, null);
    assert.equal(nowPlayingManager.updateIntervals.has(queue.guildId), false);
});

test('starting an update interval does not reset a pending Discord retry', async () => {
    const queue = createQueue('guild-start-with-retry', async () => {
        throw new Error('temporary initial edit failure');
    });
    await nowPlayingManager.onTrackStart(queue);

    assert.equal(nowPlayingManager.updateIntervals.has(queue.guildId), true);
    assert.equal(nowPlayingManager.retryTimers.has(queue.guildId), true);
    assert.equal(nowPlayingManager.retryAttempts.get(queue.guildId), 1);
});

test('a track ending during locale lookup never sends a stale card', async () => {
    let releaseLocale!: () => void;
    let enteredLocale = false;
    let sends = 0;
    const localeGate = new Promise<void>((resolve) => { releaseLocale = resolve; });
    const queue = createQueue('guild-ended-during-locale', async () => undefined);
    queue.nowPlayingMessage = null;
    queue.textChannel.send = (async () => { sends += 1; }) as never;
    const originalGetSettings = guildSettingsManager.getSettings;
    guildSettingsManager.getSettings = async (guildId: string) => {
        enteredLocale = true;
        await localeGate;
        return guildSettingsManager.getDefaults(guildId);
    };

    try {
        const creation = nowPlayingManager.onTrackStart(queue);
        await waitFor(() => enteredLocale);
        queue.currentTrack = null;
        nowPlayingManager.onTrackEnd(queue);
        releaseLocale();
        await creation;
        assert.equal(sends, 0);
        assert.equal(nowPlayingManager.updateIntervals.has(queue.guildId), false);
    } finally {
        releaseLocale();
        guildSettingsManager.getSettings = originalGetSettings;
    }
});

test('simultaneous Now Playing creations send one card without overlapping requests', async () => {
    let releaseSend!: (message: unknown) => void;
    let sends = 0;
    let edits = 0;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const queue = createQueue('guild-double-create', async () => undefined);
    queue.nowPlayingMessage = null;
    queue.textChannel.send = (async () => { sends += 1; return sendGate; }) as never;
    const creations = [nowPlayingManager.createOrUpdateNowPlaying(queue)];
    await waitFor(() => sends === 1);
    creations.push(...Array.from({ length: 9 }, () => nowPlayingManager.createOrUpdateNowPlaying(queue)));
    const message = { edit: async () => { edits += 1; }, delete: async () => undefined };
    releaseSend(message);
    await Promise.all(creations);
    assert.equal(sends, 1);
    assert.equal(edits, 1, 'les demandes simultanées fusionnent leur rafraîchissement');
    assert.equal(queue.nowPlayingMessage, message);
});

test('a slow previous-track send is deleted and the next track gets its own card', async () => {
    let releaseOldSend!: (message: unknown) => void;
    let sends = 0;
    let oldDeletes = 0;
    let nextDeletes = 0;
    const sendGate = new Promise((resolve) => { releaseOldSend = resolve; });
    const queue = createQueue('guild-track-transition-send', async () => undefined);
    const nextMessage = {
        edit: async () => undefined,
        delete: async () => { nextDeletes += 1; },
    };
    queue.nowPlayingMessage = null;
    queue.textChannel.send = (async () => {
        sends += 1;
        return sends === 1 ? sendGate : nextMessage;
    }) as never;

    const oldCreation = nowPlayingManager.onTrackStart(queue);
    await waitFor(() => sends === 1);
    queue.currentTrack = null;
    nowPlayingManager.onTrackEnd(queue);
    const cleanup = nowPlayingManager.deleteNowPlaying(queue);
    queue.currentTrack = currentTrack('next-track');
    const nextCreation = nowPlayingManager.onTrackStart(queue);
    releaseOldSend({ delete: async () => { oldDeletes += 1; } });
    await Promise.all([oldCreation, cleanup, nextCreation]);

    assert.equal(sends, 2);
    assert.equal(oldDeletes, 1);
    assert.equal(nextDeletes, 0, 'le nettoyage ancien ne doit pas capturer la carte suivante après await');
    assert.equal(queue.nowPlayingMessage, nextMessage);
    assert.equal(nowPlayingManager.updateIntervals.has(queue.guildId), true);
});

test('a deleted queue cleans its late send without starting an update interval', async () => {
    let releaseSend!: (message: unknown) => void;
    let sends = 0;
    let deletes = 0;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const queue = createQueue('guild-deleted-during-send', async () => undefined);
    queue.nowPlayingMessage = null;
    queue.textChannel.send = (async () => { sends += 1; return sendGate; }) as never;
    const creation = nowPlayingManager.onTrackStart(queue);
    await waitFor(() => sends === 1);
    queueManager.queues.delete(queue.guildId);
    const cleanup = nowPlayingManager.deleteNowPlaying(queue);
    releaseSend({ delete: async () => { deletes += 1; } });
    await Promise.all([creation, cleanup]);

    assert.equal(deletes, 1);
    assert.equal(queue.nowPlayingMessage, null);
    assert.equal(nowPlayingManager.updateIntervals.has(queue.guildId), false);
});

test('a replaced queue keeps its new card, interval, and retry when the old send completes', async () => {
    let releaseSend!: (message: unknown) => void;
    let sends = 0;
    let deletes = 0;
    let replacementDeletes = 0;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const oldQueue = createQueue('guild-replaced-during-send', async () => undefined);
    oldQueue.nowPlayingMessage = null;
    oldQueue.textChannel.send = (async () => { sends += 1; return sendGate; }) as never;
    const oldCreation = nowPlayingManager.onTrackStart(oldQueue);
    await waitFor(() => sends === 1);
    const replacement = createQueue(oldQueue.guildId, async () => undefined, async () => { replacementDeletes += 1; });
    await nowPlayingManager.onTrackStart(replacement);
    const replacementMessage = replacement.nowPlayingMessage;
    const interval = nowPlayingManager.updateIntervals.get(replacement.guildId);
    nowPlayingManager.scheduleRetry(replacement, new Error('replacement transient failure'));
    const retry = nowPlayingManager.retryTimers.get(replacement.guildId);
    const oldCleanup = nowPlayingManager.deleteNowPlaying(oldQueue);
    releaseSend({ delete: async () => { deletes += 1; } });
    await Promise.all([oldCreation, oldCleanup]);

    assert.equal(deletes, 1);
    assert.equal(replacementDeletes, 0);
    assert.equal(oldQueue.nowPlayingMessage, null);
    assert.equal(replacement.nowPlayingMessage, replacementMessage);
    assert.equal(nowPlayingManager.updateIntervals.get(replacement.guildId), interval);
    assert.equal(nowPlayingManager.retryTimers.get(replacement.guildId), retry);
});

test('an old edit failure cannot clear or delete a newer track card', async () => {
    let rejectOldEdit!: (error: unknown) => void;
    let oldEdits = 0;
    let newEdits = 0;
    let newDeletes = 0;
    const editGate = new Promise((_resolve, reject) => { rejectOldEdit = reject; });
    const queue = createQueue('guild-stale-edit-failure', async () => {
        oldEdits += 1;
        await editGate;
    });
    const oldUpdate = nowPlayingManager.updateNowPlaying(queue);
    await waitFor(() => oldEdits === 1);
    nowPlayingManager.onTrackEnd(queue);
    queue.currentTrack = currentTrack('replacement-track');
    const replacementMessage = {
        edit: async () => { newEdits += 1; },
        delete: async () => { newDeletes += 1; },
    };
    queue.nowPlayingMessage = replacementMessage as never;
    const nextUpdate = nowPlayingManager.onTrackStart(queue);
    rejectOldEdit({ code: 10008 });
    await Promise.all([oldUpdate, nextUpdate]);

    assert.equal(newEdits, 1);
    assert.equal(newDeletes, 0);
    assert.equal(queue.nowPlayingMessage, replacementMessage);
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
