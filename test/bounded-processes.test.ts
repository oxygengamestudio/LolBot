import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDataDir = join(tmpdir(), `lolbot-processes-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;

let manager: any;
let config: typeof import('../src/config.js').config;

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    const cacheModule = await import('../src/audio/MediaCacheManager.js');
    ({ config } = await import('../src/config.js'));
    manager = new cacheModule.MediaCacheManager();
    await manager.ready;
    manager.ytdlpPath = process.execPath;
});

after(async () => {
    await rm(testDataDir, { recursive: true, force: true });
});

async function processExists(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

test('a stuck yt-dlp receives SIGTERM and is force-killed after the grace period', async () => {
    const originalTimeout = config.audio.ytDlpTimeoutMs;
    config.audio.ytDlpTimeoutMs = 300;
    const pidPath = join(testDataDir, 'stuck-ytdlp.pid');
    const script = [
        "const fs = require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
        "process.on('SIGTERM', () => {})",
        'setInterval(() => {}, 1000)',
    ].join(';');

    try {
        const startedAt = Date.now();
        assert.equal(await manager.runYtdlpText(['-e', script]), null);
        const childPid = Number(await readFile(pidPath, 'utf8'));
        assert.equal(await processExists(childPid), false);
        assert.ok(Date.now() - startedAt >= 2_150, 'le permit reste détenu jusqu’au SIGKILL effectif');
        assert.ok(Date.now() - startedAt < 4_500, 'l’arrêt forcé reste borné');
    } finally {
        config.audio.ytDlpTimeoutMs = originalTimeout;
    }
});

test('yt-dlp output is bounded and an excessive producer is terminated', async () => {
    const originalTimeout = config.audio.ytDlpTimeoutMs;
    config.audio.ytDlpTimeoutMs = 5_000;
    const script = "process.stdout.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000)";
    const startedAt = Date.now();

    try {
        assert.equal(await manager.runYtdlpText(['-e', script]), null);
        assert.ok(Date.now() - startedAt < 2_000, 'la limite de sortie doit interrompre le processus rapidement');
    } finally {
        config.audio.ytDlpTimeoutMs = originalTimeout;
    }
});

test('the FFmpeg process wrapper also enforces its output ceiling', async () => {
    const originalTimeout = config.audio.cacheDownloadTimeoutMs;
    config.audio.cacheDownloadTimeoutMs = 5_000;
    const script = "process.stderr.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000)";

    try {
        const result = await manager.runProcess(process.execPath, ['-e', script]);
        assert.equal(result.success, false);
        assert.match(String(result.error), /volumineuse/i);
    } finally {
        config.audio.cacheDownloadTimeoutMs = originalTimeout;
    }
});

test('the FFmpeg cache writer refuses bytes beyond its reserved output budget', async () => {
    const outputPath = join(testDataDir, 'bounded-media.tmp');
    const maximum = 32 * 1024;
    const script = "process.stdout.write('x'.repeat(96 * 1024)); setInterval(() => {}, 1000)";

    const result = await manager.runProcessToFile(
        process.execPath,
        ['-e', script],
        outputPath,
        maximum
    );

    assert.equal(result.success, false);
    assert.match(String(result.error), /supérieure/i);
    const info = await stat(outputPath).catch(() => null);
    assert.ok(!info || info.size <= maximum, 'aucun octet au-delà du budget ne doit être écrit');
    await rm(outputPath, { force: true });
});
