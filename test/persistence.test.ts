import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildSettingsManager } from '../src/services/GuildSettingsManager.js';
import { BoundedTtlCache } from '../src/utils/BoundedTtlCache.js';
import { QueueRecoveryStore, validateSnapshot, RECOVERY_TTL } from '../src/services/QueueRecoveryStore.js';

const guild = '123456789012345678';
async function directory(t: any) {
    const path = await mkdtemp(join(tmpdir(), 'lolbot-persistence-'));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

test('concurrent settings loads and updates retain independent changes and flush atomically', async t => {
    const dir = await directory(t);
    const manager = new GuildSettingsManager(dir, dir);
    const [first, second] = await Promise.all([manager.getSettings(guild), manager.getSettings(guild)]);
    assert.equal(first, second);
    assert.equal(first.queueRecoveryEnabled, false);
    await Promise.all([manager.updateSettings(guild, { volume: 75 }),
        manager.updateSettings(guild, { queueRecoveryEnabled: true }),
        manager.updateSettings(guild, { rolePermissionMode: 'whitelist' })]);
    await manager.flushAll();
    const saved = JSON.parse(await readFile(join(dir, guild, 'settings.json'), 'utf8'));
    assert.equal(saved.volume, 75);
    assert.equal(saved.queueRecoveryEnabled, true);
    assert.equal(saved.rolePermissionMode, 'whitelist');
    assert.equal(manager.pendingWrites, 0);
    assert.deepEqual(await readdir(join(dir, guild)), ['settings.json']);
    const reloaded = new GuildSettingsManager(dir, dir);
    assert.equal((await reloaded.getSettings(guild)).volume, 75);
});

test('corrupt settings fail closed without replacing the original policy', async t => {
    const dir = await directory(t);
    await mkdir(join(dir, guild));
    await writeFile(join(dir, guild, 'settings.json'), '{broken');
    const manager = new GuildSettingsManager(dir, dir);
    await assert.rejects(manager.getSettings(guild));
    assert.equal(await readFile(join(dir, guild, 'settings.json'), 'utf8'), '{broken');
    await assert.rejects(manager.getSettings('../escape'));
});

test('bounded TTL cache evicts LRU, preserves null values and expires entries', t => {
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);
    const cache = new BoundedTtlCache<string, number | null>(2, 100);
    cache.set('a', null); cache.set('b', 2);
    assert.equal(cache.get('a'), null);
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined);
    now += 100;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0);
});

function snapshot() {
    return { version: 1, guildId: guild, textChannelId: guild, voiceChannelId: guild, updatedAt: Date.now(),
        tracks: [{ id: 'abcdefghijk', title: 'Track', duration: 120, url: 'http://internal/secret',
            requestedBy: 'DJ', requestedById: guild, thumbnail: 'http://internal/image' }] };
}

test('queue snapshots round-trip canonical public identifiers only and can be discarded', async t => {
    const store = new QueueRecoveryStore(await directory(t));
    await store.save(guild, snapshot() as any);
    const saved = await store.load(guild);
    assert.equal(saved?.tracks[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(saved?.tracks[0].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    await store.save(guild, null);
    assert.equal(await store.load(guild), null);
});

test('queue snapshots reject expired, cross-guild, malformed and unsafe identifiers', () => {
    for (const value of [null, { ...snapshot(), guildId: 'other' }, { ...snapshot(), version: 2 },
        { ...snapshot(), updatedAt: Date.now() - RECOVERY_TTL }, { ...snapshot(), updatedAt: Date.now() + 120_000 },
        { ...snapshot(), voiceChannelId: '../escape' }, { ...snapshot(), tracks: [{ ...snapshot().tracks[0], id: '../../bad' }] }]) {
        assert.equal(validateSnapshot(value, guild), null);
    }
});

test('SoundCloud recovery retains its provider but rejects private and redirect URLs', () => {
    const track = { ...snapshot().tracks[0], id: 'soundcloud:1234', provider: 'soundcloud',
        canonicalUrl: 'https://soundcloud.com/artist/public-track', thumbnail: 'https://i1.sndcdn.com/artwork.jpg' };
    const saved = validateSnapshot({ ...snapshot(), tracks: [track] }, guild);
    assert.equal(saved?.tracks[0].provider, 'soundcloud');
    assert.equal(saved?.tracks[0].sourceId, '1234');
    assert.equal(saved?.tracks[0].url, track.canonicalUrl);
    for (const canonicalUrl of ['https://soundcloud.com/artist/track/s-secret',
        'https://soundcloud.com/artist/track?secret_token=secret', 'https://on.soundcloud.com/abc',
        'http://127.0.0.1/track', 'https://soundcloud.com.evil.test/artist/track']) {
        assert.equal(validateSnapshot({ ...snapshot(), tracks: [{ ...track, canonicalUrl }] }, guild), null);
    }
});
