import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';

let config: typeof import('../src/config.js').config;
let YtdlpRunner: typeof import('../src/services/providers/YtdlpRunner.js').YtdlpRunner;
let originalTimeoutMs: number;
let originalYtdlpPath: string | undefined;
let originalCookies: string | undefined;
let originalBrowserCookies: string | undefined;
let originalExtraArgs: string | undefined;

before(async () => {
    ({ config } = await import('../src/config.js'));
    ({ YtdlpRunner } = await import('../src/services/providers/YtdlpRunner.js'));
    originalTimeoutMs = config.audio.ytDlpTimeoutMs;
    originalYtdlpPath = process.env.YTDLP_PATH;
    originalCookies = process.env.YTDLP_COOKIES;
    originalBrowserCookies = process.env.YTDLP_COOKIES_FROM_BROWSER;
    originalExtraArgs = process.env.YTDLP_EXTRA_ARGS;
    process.env.YTDLP_PATH = process.execPath;
    delete process.env.YTDLP_COOKIES;
    delete process.env.YTDLP_COOKIES_FROM_BROWSER;
    delete process.env.YTDLP_EXTRA_ARGS;
});

after(() => {
    config.audio.ytDlpTimeoutMs = originalTimeoutMs;
    if (originalYtdlpPath === undefined) delete process.env.YTDLP_PATH;
    else process.env.YTDLP_PATH = originalYtdlpPath;
    if (originalCookies === undefined) delete process.env.YTDLP_COOKIES;
    else process.env.YTDLP_COOKIES = originalCookies;
    if (originalBrowserCookies === undefined) delete process.env.YTDLP_COOKIES_FROM_BROWSER;
    else process.env.YTDLP_COOKIES_FROM_BROWSER = originalBrowserCookies;
    if (originalExtraArgs === undefined) delete process.env.YTDLP_EXTRA_ARGS;
    else process.env.YTDLP_EXTRA_ARGS = originalExtraArgs;
});

test('yt-dlp JSON execution uses an argument array and parses one bounded payload', async () => {
    const runner = new YtdlpRunner();
    const result = await runner.runJson([
        '-e',
        'process.stdout.write(JSON.stringify({ok:true,value:"literal;not-a-shell"}))',
    ]);
    assert.deepEqual(result, { ok: true, value: 'literal;not-a-shell' });
});

test('yt-dlp runner terminates a process that exceeds its timeout', async () => {
    const runner = new YtdlpRunner();
    config.audio.ytDlpTimeoutMs = 30;
    await assert.rejects(
        runner.runText(['-e', 'setInterval(() => {}, 1000)']),
        /timed out after 30ms/
    );
});

test('yt-dlp runner terminates producers beyond the stdout ceiling', async () => {
    const runner = new YtdlpRunner();
    config.audio.ytDlpTimeoutMs = 2_000;
    await assert.rejects(
        runner.runText(['-e', 'process.stdout.write("x".repeat(9 * 1024 * 1024))']),
        /stdout exceeded/
    );
});

test('an aborted waiter never starts after the four-process global limit is occupied', async () => {
    const runner = new YtdlpRunner();
    config.audio.ytDlpTimeoutMs = 2_000;
    const activeControllers = Array.from({ length: 4 }, () => new AbortController());
    const active = activeControllers.map((controller) =>
        runner.runText(['-e', 'setInterval(() => {}, 1000)'], controller.signal).catch((error) => error)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const waitingController = new AbortController();
    const waiting = runner.runText(
        ['-e', 'process.stdout.write("should-not-run")'],
        waitingController.signal
    );
    waitingController.abort();
    await assert.rejects(waiting, (error: any) => error?.name === 'AbortError');

    activeControllers.forEach((controller) => controller.abort());
    const activeResults = await Promise.all(active);
    assert.equal(activeResults.every((error) => error?.name === 'AbortError'), true);
});
