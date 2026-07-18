import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Track } from '../src/types/index.js';

const testDataDir = join(tmpdir(), `lolbot-media-cache-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;
process.env.CACHE_MAX_MB = '1';
process.env.CACHE_MAX_AGE_HOURS = '1';
process.env.CACHE_DOWNLOAD_CONCURRENCY = '2';

let MediaCacheManager: typeof import('../src/audio/MediaCacheManager.js').MediaCacheManager;
let config: typeof import('../src/config.js').config;

function track(id: string): Track {
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

function fileName(cacheKey: string, container: 'ogg' | 'webm' = 'ogg'): string {
    return `media-${Buffer.from(cacheKey).toString('base64url')}.${container}`;
}

async function writeManifest(
    root: string,
    items: Array<{ id: string; size: number; lastUsedAt: number; container?: 'ogg' | 'webm' }>
) {
    const audioDir = join(root, 'audio');
    await mkdir(audioDir, { recursive: true });
    const entries = [];
    for (const item of items) {
        const cacheKey = `youtube:${item.id}`;
        const container = item.container ?? 'ogg';
        const file = fileName(cacheKey, container);
        await writeFile(join(audioDir, file), Buffer.alloc(item.size, item.id.charCodeAt(0) || 1));
        entries.push({
            cacheKey,
            provider: 'youtube',
            sourceId: item.id,
            file,
            size: item.size,
            downloadedAt: item.lastUsedAt,
            lastUsedAt: item.lastUsedAt,
            codec: 'opus',
            container,
        });
    }
    await writeFile(join(audioDir, 'manifest.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

async function managerFor(root: string) {
    config.paths.cache = root;
    const manager = new MediaCacheManager();
    await (manager as any).ready;
    return manager;
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    ({ MediaCacheManager } = await import('../src/audio/MediaCacheManager.js'));
    ({ config } = await import('../src/config.js'));
});

after(async () => {
    await rm(testDataDir, { recursive: true, force: true });
});

test('a valid manifest survives a new manager instance and uses provider:sourceId keys', async () => {
    const root = join(testDataDir, 'persistent');
    const now = Date.now();
    await writeManifest(root, [{ id: 'persisted', size: 32, lastUsedAt: now }]);

    const first = await managerFor(root);
    const firstPath = await first.getTrackPath(track('persisted'));
    await (first as any).manifestWrite;
    const second = await managerFor(root);
    const secondPath = await second.getTrackPath('youtube:persisted');

    assert.ok(firstPath?.endsWith('.ogg'));
    assert.equal(secondPath, firstPath);
    const manifest = JSON.parse(await readFile(join(root, 'audio', 'manifest.json'), 'utf8'));
    assert.equal(manifest.entries[0].cacheKey, 'youtube:persisted');
});

test('stale bounded download and manifest temp files are removed on restart', async () => {
    const root = join(testDataDir, 'stale-temp');
    const audioDir = join(root, 'audio');
    await mkdir(audioDir, { recursive: true });
    const mediaTemp = join(audioDir, 'media-stale.123.tmp');
    const manifestTemp = join(audioDir, 'manifest.json.123.tmp');
    await writeFile(mediaTemp, Buffer.alloc(64));
    await writeFile(manifestTemp, '{}');

    await managerFor(root);

    await assert.rejects(readFile(mediaTemp));
    await assert.rejects(readFile(manifestTemp));
});

test('expired entries are rejected by the TTL even when present on disk', async () => {
    const root = join(testDataDir, 'ttl');
    await writeManifest(root, [{
        id: 'expired',
        size: 32,
        lastUsedAt: Date.now() - 2 * 60 * 60 * 1000,
    }]);

    const manager = await managerFor(root);
    assert.equal(await manager.getTrackPath(track('expired')), null);
    assert.equal(manager.getCacheSize(), 0);
});

test('capacity eviction is LRU and keeps the most recently used entry', async () => {
    const root = join(testDataDir, 'lru');
    const now = Date.now();
    await writeManifest(root, [
        { id: 'old', size: 700 * 1024, lastUsedAt: now - 10_000 },
        { id: 'new', size: 700 * 1024, lastUsedAt: now },
    ]);

    const manager = await managerFor(root);
    assert.equal(await manager.getTrackPath(track('old')), null);
    assert.ok(await manager.getTrackPath(track('new')));
    assert.equal(manager.getCacheSize(), 1);
});

test('an actively leased cache file is never credited as evicted capacity', async () => {
    const root = join(testDataDir, 'active-lease');
    const now = Date.now();
    await writeManifest(root, [{ id: 'playing', size: 700 * 1024, lastUsedAt: now }]);
    const manager = await managerFor(root) as any;
    const lease = await manager.acquireTrackPath(track('playing'));
    assert.ok(lease);

    const reservation = await manager.reserveOutputBudget('youtube:next');

    assert.equal(reservation, 324 * 1024, 'seul l’espace réellement libre peut être réservé');
    assert.equal(manager.getCacheSize(), 1);
    assert.ok(await manager.getTrackPath(track('playing')));

    manager.clearTrack(track('playing'));
    assert.equal(manager.getCacheSize(), 1, 'la suppression est différée tant que le fichier est lu');
    lease.release();
    assert.equal(manager.getCacheSize(), 0);
});

test('concurrent requests for one source share a single download', async () => {
    const root = join(testDataDir, 'single-flight');
    const manager = await managerFor(root);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (manager as any).downloadTrack = async () => {
        calls += 1;
        await gate;
        return '/tmp/cached-once.ogg';
    };

    const first = manager.ensureCached(track('deduplicated'));
    const second = manager.ensureCached(track('deduplicated'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();

    assert.equal(await first, '/tmp/cached-once.ogg');
    assert.equal(await second, '/tmp/cached-once.ogg');
    assert.equal(calls, 1);
});

test('preload selection is round-robin across guild queues', async () => {
    const root = join(testDataDir, 'fairness');
    const manager = await managerFor(root) as any;
    manager.preloadQueues.set('guild-a', [track('a1'), track('a2')]);
    manager.preloadQueues.set('guild-b', [track('b1'), track('b2')]);
    manager.preloadGuildOrder.push('guild-a', 'guild-b');

    const first = manager.takeNextPreload();
    const second = manager.takeNextPreload();
    assert.equal(manager.takeNextPreload(), null, 'une guilde ne peut pas avoir deux preloads actifs');

    manager.activePreloadGuilds.delete(first.guildId);
    manager.preloadGuildOrder.push(first.guildId);
    const third = manager.takeNextPreload();
    manager.activePreloadGuilds.delete(second.guildId);
    manager.preloadGuildOrder.push(second.guildId);
    const fourth = manager.takeNextPreload();

    const order = [first.track.id, second.track.id, third.track.id, fourth.track.id];
    assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2']);
});

test('the global cache download semaphore never exceeds two operations', async () => {
    const root = join(testDataDir, 'semaphore');
    const manager = await managerFor(root) as any;
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = () => manager.withDownloadSlot(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
    });

    const pending = [operation(), operation(), operation()];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(maximum, 2);
    release();
    await Promise.all(pending);
    assert.equal(maximum, 2);
});

test('concurrent cache outputs share the aggregate disk budget', async () => {
    const root = join(testDataDir, 'output-reservations');
    const manager = await managerFor(root) as any;

    const first = await manager.reserveOutputBudget('youtube:first');
    const second = await manager.reserveOutputBudget('youtube:second');

    assert.equal(first, 1024 * 1024);
    assert.equal(second, 0, 'un second FFmpeg ne peut pas réserver au-delà du plafond global');
    assert.equal(manager.reservedOutputBytes, 1024 * 1024);
});

test('an unlink awaiting physical confirmation is not credited to a new output', async () => {
    const root = join(testDataDir, 'pending-unlink-budget');
    const manager = await managerFor(root) as any;
    manager.pendingUnlinkedBytes = 256 * 1024;

    const reservation = await manager.reserveOutputBudget('youtube:next');

    assert.equal(reservation, 768 * 1024);
    manager.reservedOutputBytes -= reservation;
    manager.pendingUnlinkedBytes = 0;
});
