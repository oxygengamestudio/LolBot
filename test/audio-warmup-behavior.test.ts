import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

test('direct media URLs are not published until a complete line or successful process exit', async () => {
    const originalPath = wrapper.ytdlpPath;
    const originalArgs = wrapper.getYtdlpExtraArgs;
    const expectedUrl = 'https://rr1.googlevideo.com/videoplayback?expire=123&sig=complete-signature';
    wrapper.ytdlpPath = process.execPath;

    const resolveWithScript = (script: string, timeout = 2_000, signal?: AbortSignal) => {
        wrapper.getYtdlpExtraArgs = () => ['-e', script, '--'];
        return originalFetch.call(wrapper, 'guild-chunked-url', track('chunked').url, false, timeout, signal);
    };

    try {
        assert.equal(wrapper.findDirectStreamUrl('https://rr1.googlevideo.com/videoplayback?sig=part'), null);
        assert.equal(wrapper.findDirectStreamUrl(`${expectedUrl}\r\n`), expectedUrl);
        assert.equal(wrapper.findDirectStreamUrl(expectedUrl, true), expectedUrl);
        assert.equal(wrapper.isLikelyDirectStreamUrl('https://googlevideo.com.evil.invalid/videoplayback'), false);
        assert.equal(wrapper.isLikelyDirectStreamUrl('https://evil-googlevideo.com/videoplayback'), false);

        const chunked = await resolveWithScript([
            "process.stdout.write('https://rr1.googlevideo.com/videoplayback?expire=123&sig=')",
            "setTimeout(() => process.stdout.write('complete-signature\\n'), 50)",
            'setTimeout(() => {}, 5_000)',
        ].join(';'));
        assert.equal(chunked.url, expectedUrl, 'a syntactically valid partial URL must not terminate yt-dlp');

        const unterminated = await resolveWithScript(`process.stdout.write(${JSON.stringify(expectedUrl)})`);
        assert.equal(unterminated.url, expectedUrl, 'EOF can terminate the final line after a successful exit');

        const failed = await resolveWithScript(`process.stdout.write(${JSON.stringify(expectedUrl)}); process.exitCode = 1`);
        assert.equal(failed.url, null, 'an unfinished line from a failed child is not trusted');

        const timedOut = await resolveWithScript(
            `process.stdout.write(${JSON.stringify(expectedUrl)}); setTimeout(() => {}, 5_000)`, 200
        );
        assert.equal(timedOut.url, null, 'a timeout must not publish an unfinished signed URL');

        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 100);
        try {
            const aborted = await resolveWithScript(
                `process.stdout.write(${JSON.stringify(expectedUrl)}); setTimeout(() => {}, 5_000)`, 2_000, controller.signal
            );
            assert.equal(aborted.url, null);
            assert.match(aborted.ytdlpErrors, /annul/i);
        } finally {
            clearTimeout(abortTimer);
        }

        const excessive = await resolveWithScript("process.stdout.write('x'.repeat(70 * 1024)); setTimeout(() => {}, 5_000)");
        assert.equal(excessive.url, null);
        assert.match(excessive.ytdlpErrors, /exceeded limit/);
    } finally {
        wrapper.ytdlpPath = originalPath;
        wrapper.getYtdlpExtraArgs = originalArgs;
    }
});

test('media failure diagnostics classify errors without publishing signed URLs or cookies', () => {
    const signedUrl = 'https://rr1.googlevideo.com/videoplayback?sig=private-signature&token=private-token';
    const samples = [
        [`HTTP error 403 Forbidden: ${signedUrl}`, 'http_403'],
        [`Server returned 429: ${signedUrl}`, 'http_429'],
        [`Connection timed out for ${signedUrl}`, 'timeout'],
        [`Invalid data found when processing input ${signedUrl}`, 'invalid_media'],
        [`Could not copy cookie database /private/cookies.txt ${signedUrl}`, 'cookie_access_failed'],
        [`Sign in to confirm your age ${signedUrl}`, 'authentication_required'],
        [`unrecognized failure ${signedUrl}`, 'unclassified_error'],
        ['', 'no_error_detail'],
    ];
    for (const [message, category] of samples) {
        assert.equal(wrapper.classifyMediaFailure(message), category);
    }
    const safeArgs = wrapper.sanitizeYtdlpArgsForLogs([
        '--cookies', '/private/cookies.txt', '--proxy=https://user:password@proxy.invalid',
        '--add-header', 'Cookie: session=private-cookie', '--referer', signedUrl,
        '--quiet', signedUrl,
    ]);
    assert.doesNotMatch(safeArgs, /private-|cookies\.txt|password|googlevideo\.com|session=/);
    assert.match(safeArgs, /url redacted/);
});

test('direct FFmpeg failure is visible without leaking its signed input URL', { skip: process.platform === 'win32' }, async () => {
    const executablePath = join(testDataDir, 'failing-ffmpeg');
    const signedUrl = 'https://media.invalid/audio?sig=private-signature&token=private-token';
    await writeFile(executablePath, [
        `#!${process.execPath}`,
        `process.stderr.write(${JSON.stringify(`HTTP error 403 Forbidden: ${signedUrl}\n`)})`,
        'process.exitCode = 1',
    ].join('\n'));
    await chmod(executablePath, 0o700);

    const { logger } = await import('../src/utils/Logger.js');
    const originalPath = wrapper.ffmpegPath;
    const originalWarn = logger.warn;
    const warnings: unknown[] = [];
    logger.warn = (_module: string, message: string, data?: unknown) => { warnings.push([message, data]); };
    wrapper.ffmpegPath = executablePath;
    try {
        const created = await wrapper.createResourceWithDirectUrl('guild-diagnostic', track('diagnostic'), signedUrl, 0);
        assert.equal(created, null);
        const diagnostic = warnings.find((entry) => JSON.stringify(entry).includes('http_403'));
        assert.ok(diagnostic, 'direct FFmpeg failures must emit an actionable warning');
        assert.doesNotMatch(JSON.stringify(warnings), /private-|media\.invalid|sig=/);
    } finally {
        wrapper.ffmpegPath = originalPath;
        logger.warn = originalWarn;
    }
});

test('readiness requires an actual encoded frame and allows FFmpeg to drain after yt-dlp succeeds', async () => {
    const empty = new PassThrough({ objectMode: true });
    const emptyReady = wrapper.waitForReadableStreamReady(empty, 500);
    empty.end();
    assert.equal(await emptyReady, 'close', 'EOF emits readable even without any packet');

    const destroyed = new PassThrough({ objectMode: true });
    destroyed.write(Buffer.from([1]));
    destroyed.destroy();
    assert.equal(await wrapper.waitForReadableStreamReady(destroyed, 500), 'close', 'buffered packets on a destroyed stream are not playable');

    const processEmpty = new PassThrough({ objectMode: true });
    const child = new EventEmitter();
    const processReady = wrapper.waitForProcessStreamReady(processEmpty, child, 500);
    processEmpty.end();
    assert.equal(await processReady, 'close');
    assert.equal(child.listenerCount('close'), 0);

    const packets = new PassThrough({ objectMode: true });
    const producer = new EventEmitter();
    const transcoder = new EventEmitter();
    const draining = wrapper.waitForStreamReady(packets, producer, transcoder, 500);
    producer.emit('close', 0);
    const encodedFrame = Buffer.from([1, 2, 3]);
    packets.write(encodedFrame);
    assert.equal(await draining, 'ready', 'a completed input is not a failed output');
    assert.deepEqual(packets.read(), encodedFrame, 'readiness does not consume a packet');
    assert.equal(producer.listenerCount('close'), 0);
    assert.equal(transcoder.listenerCount('close'), 0);
    packets.destroy();
});

test('direct PCM is encoded and drained completely while diagnostics count without consuming data', { skip: process.platform === 'win32' }, async () => {
    const executablePath = join(testDataDir, 'pcm-ffmpeg');
    const pcmBytes = 48_000 * 2 * 2;
    await writeFile(executablePath, [
        `#!${process.execPath}`,
        `process.stdout.write(Buffer.alloc(${pcmBytes}))`,
    ].join('\n'));
    await chmod(executablePath, 0o700);
    const originalPath = wrapper.ffmpegPath;
    wrapper.ffmpegPath = executablePath;
    try {
        const created = await wrapper.createResourceWithDirectUrl('guild-pcm', track('pcm'), 'https://media.invalid/audio', 0);
        assert.ok(created, 'valid encoded packets should become playable');
        let frames = 0;
        for await (const packet of created.playStream) {
            assert.ok(packet.length > 0);
            frames += 1;
        }
        await created.metadata.fullyClosed;
        assert.equal(frames, 50, 'the full one-second PCM input must yield fifty 20ms Opus frames');
        assert.equal(created.metadata.outputBytes, pcmBytes);
        assert.equal(created.metadata.sourceMode, 'direct-ffmpeg');
    } finally {
        wrapper.ffmpegPath = originalPath;
    }
});

test('native network stream errors are contained and release the upstream response', async () => {
    const originalNetworkFetch = globalThis.fetch;
    let requestSignal: AbortSignal | null = null;
    let errorTimer: NodeJS.Timeout | undefined;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
        requestSignal = options?.signal ?? null;
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                // An incomplete, plausible Ogg header keeps the demuxer waiting.
                controller.enqueue(Buffer.from('OggS'));
                errorTimer = setTimeout(() => controller.error(new Error('Connection reset by peer')), 25);
            },
        }));
    }) as typeof fetch;
    try {
        const created = await wrapper.createNativeOpusResource(track('network-reset'), 'https://media.invalid/audio.ogg', 'ogg/opus', 0);
        assert.equal(created, null, 'a failed HTTP body must not become a playable resource');
        assert.equal((requestSignal as AbortSignal | null)?.aborted, true, 'the associated request is cancelled');
    } finally {
        if (errorTimer) clearTimeout(errorTimer);
        globalThis.fetch = originalNetworkFetch;
    }
});

test('native explicit teardown consumes abort errors from the upstream response', async () => {
    const originalNetworkFetch = globalThis.fetch;
    const originalReadiness = wrapper.waitForReadableStreamReady;
    let abortObserved = false;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Buffer.from('OggS'));
                options?.signal?.addEventListener('abort', () => {
                    abortObserved = true;
                    controller.error(new DOMException('Expected request abort', 'AbortError'));
                }, { once: true });
            },
        }));
    }) as typeof fetch;
    // Simulate Stop while the already-created resource still awaits more data.
    wrapper.waitForReadableStreamReady = async () => 'timeout';
    try {
        const created = await wrapper.createNativeOpusResource(track('native-stop'), 'https://media.invalid/audio.ogg', 'ogg/opus', 0);
        assert.ok(created);
        created.metadata.teardown();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(abortObserved, true);
        assert.equal(created.metadata.pipelineCloseReason, 'native opus resource teardown requested');
        assert.equal(created.metadata.failureCategory, undefined, 'normal cancellation is not a media failure');
        created.playStream.destroy();
    } finally {
        globalThis.fetch = originalNetworkFetch;
        wrapper.waitForReadableStreamReady = originalReadiness;
    }
});

test('an explicitly stopped FFmpeg is not reported as a failed media pipeline', { skip: process.platform === 'win32' }, async () => {
    const executablePath = join(testDataDir, 'stoppable-ffmpeg');
    await writeFile(executablePath, [
        `#!${process.execPath}`,
        "process.on('SIGTERM', () => process.exit(255))",
        'process.stdout.write(Buffer.alloc(3840))',
        'setInterval(() => {}, 1_000)',
    ].join('\n'));
    await chmod(executablePath, 0o700);
    const { logger } = await import('../src/utils/Logger.js');
    const originalPath = wrapper.ffmpegPath;
    const originalWarn = logger.warn;
    const warnings: unknown[] = [];
    logger.warn = (_module: string, message: string, data?: unknown) => { warnings.push([message, data]); };
    wrapper.ffmpegPath = executablePath;
    try {
        const created = await wrapper.createResourceWithDirectUrl('guild-stop', track('direct-stop'), 'https://media.invalid/audio', 0);
        assert.ok(created);
        created.metadata.teardown();
        await created.metadata.fullyClosed;
        assert.equal(created.metadata.processExitCode, 255);
        assert.equal(created.metadata.failureCategory, undefined);
        assert.deepEqual(warnings, []);
        created.playStream.destroy();
    } finally {
        wrapper.ffmpegPath = originalPath;
        logger.warn = originalWarn;
    }
});
