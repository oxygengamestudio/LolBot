import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Track } from '../src/types/index.js';

const testDataDir = join(tmpdir(), `lolbot-warmup-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;
process.env.CACHE_DOWNLOAD_CONCURRENCY = '2';
delete process.env.YTDLP_COOKIES;
delete process.env.YTDLP_COOKIES_FROM_BROWSER;

let wrapper: any;
let originalFetch: any;

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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Condition de test non satisfaite à temps');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    ({ audioWrapper: wrapper } = await import('../src/audio/AudioWrapper.js'));
    originalFetch = wrapper.fetchDirectStreamUrl;
});

after(async () => {
    wrapper.fetchDirectStreamUrl = originalFetch;
    wrapper.clearCache();
    await rm(testDataDir, { recursive: true, force: true });
});

test('warmups are globally bounded and stale guild work is cancelled before publication', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    let calls = 0;
    wrapper.fetchDirectStreamUrl = async (_guildId: string, url: string) => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { url: `${url}&direct=1`, ytdlpErrors: '' };
    };

    const globalWarmups = [
        wrapper.warmTrack('guild-a', track('a')),
        wrapper.warmTrack('guild-b', track('b')),
        wrapper.warmTrack('guild-c', track('c')),
    ];
    await waitFor(() => calls === 2);
    assert.equal(maximum, 2, 'deux warmups globaux au maximum');
    releases.shift()?.();
    await waitFor(() => calls === 3);
    assert.equal(maximum, 2, 'le troisième attend qu’un slot global soit libéré');
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(globalWarmups);

    let firstAborted = false;
    let firstClosed = false;
    wrapper.fetchDirectStreamUrl = async (_guildId: string, url: string, _cookies: boolean, _timeout: number, signal: AbortSignal) => {
        if (url.includes('old')) {
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                    firstAborted = true;
                    setTimeout(() => {
                        firstClosed = true;
                        resolve();
                    }, 40);
                }, { once: true });
            });
            return { url: `${url}&stale=1`, ytdlpErrors: '' };
        }
        assert.equal(firstClosed, true, 'le warmup précédent est fermé avant le suivant de la guilde');
        return { url: `${url}&direct=1`, ytdlpErrors: '' };
    };

    const oldWarmup = wrapper.warmTrack('guild-race', track('old'));
    await waitFor(() => (wrapper.warmupInFlight as Map<string, unknown>).has('guild-race:old'));
    const newWarmup = wrapper.warmTrack('guild-race', track('new'));
    await Promise.all([oldWarmup, newWarmup]);

    assert.equal(firstAborted, true);
    assert.equal(wrapper.isTrackWarm('guild-race', 'old'), false, 'le résultat obsolète ne doit jamais être publié');
    assert.equal(wrapper.isTrackWarm('guild-race', 'new'), true);

    wrapper.fetchDirectStreamUrl = async (_guildId: string, _url: string, _cookies: boolean, _timeout: number, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => setTimeout(resolve, 40), { once: true }));
        return { url: 'https://example.invalid/stale', ytdlpErrors: '' };
    };
    const cancelled = wrapper.warmTrack('guild-leave', track('leave'));
    await waitFor(() => (wrapper.warmupInFlight as Map<string, unknown>).has('guild-leave:leave'));
    const startedAt = Date.now();
    await wrapper.cancelGuildWarmups('guild-leave');
    assert.ok(Date.now() - startedAt >= 30, 'l’annulation attend la fermeture de l’opération active');
    await cancelled;
    assert.equal(wrapper.isTrackWarm('guild-leave', 'leave'), false);
});

test('SoundCloud direct streams are trusted only on sndcdn and never use SponsorBlock', () => {
    const soundCloudTrack: Track = {
        ...track('soundcloud:2011421339'),
        provider: 'soundcloud',
        sourceId: '2011421339',
        canonicalUrl: 'https://soundcloud.com/skorxh/audio-dealer',
        url: 'https://soundcloud.com/skorxh/audio-dealer',
    };

    assert.equal(wrapper.isLikelyDirectStreamUrl('https://cf-media.sndcdn.com/example.128.mp3'), true);
    assert.equal(wrapper.isLikelyDirectStreamUrl('https://cf-hls-media.sndcdn.com/media/playlist.m3u8'), true);
    assert.equal(wrapper.isLikelyDirectStreamUrl('https://sndcdn.com/audio'), true);
    assert.equal(wrapper.isLikelyDirectStreamUrl('https://evil-sndcdn.com/audio.mp3'), false);
    assert.equal(wrapper.isLikelyDirectStreamUrl('https://example.com/audio.mp3'), false);
    assert.equal(wrapper.shouldUseSponsorBlock(soundCloudTrack, true), false);
    assert.equal(wrapper.shouldUseSponsorBlock(track('youtube-track'), true), true);
    assert.equal(wrapper.shouldUseSponsorBlock(track('youtube-track'), false), false);
});
