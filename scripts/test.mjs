import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const tests = readdirSync(testDir).filter(name => name.endsWith('.test.ts')).sort();
if (!tests.length) throw new Error('No regression tests found');
const isolatedDir = mkdtempSync(join(tmpdir(), 'lolbot-tests-'));

// Run outside the checkout so dotenv cannot read real bot credentials.
const env = {};
for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, {
    NODE_ENV: 'test', DISCORD_TOKEN: 'offline-test', DISCORD_CLIENT_ID: '123456789012345678',
    DATA_DIR: isolatedDir, LOG_LEVEL: 'NONE', YTDLP_AUTO_DOWNLOAD: 'false', DOTENV_CONFIG_QUIET: 'true',
});
try {
    const result = spawnSync(process.execPath, [
        '--import', import.meta.resolve('tsx'), ...(process.argv.includes('--coverage') ? ['--experimental-test-coverage'] : []), '--test',
        ...tests.map(name => join(testDir, name)),
    ], { cwd: isolatedDir, env, stdio: 'inherit', timeout: 60_000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(isolatedDir, { recursive: true, force: true });
}
