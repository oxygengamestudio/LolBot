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

function createQueue(guildId: string, edit: () => Promise<unknown>): GuildQueue {
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
        nowPlayingMessage: { edit, delete: async () => undefined },
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
    nowPlayingManager.retryBaseDelayMs = 1_000;
    nowPlayingManager.retryMaxDelayMs = 30_000;
    nowPlayingManager.retryJitterMs = 250;
    queueManager.queues.clear();
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    ({ queueManager } = await import('../src/services/QueueManager.js'));
    ({ nowPlayingManager } = await import('../src/services/NowPlayingManager.js'));
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
