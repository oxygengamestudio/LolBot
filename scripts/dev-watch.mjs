import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { config as dotenvConfig } from 'dotenv';

if (process.env.BOT_ENV_FILE) dotenvConfig({ path: process.env.BOT_ENV_FILE, override: false });
dotenvConfig({ override: false });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return;
    }

    if (!isProcessAlive(pid)) {
        return;
    }

    console.log(`[dev] Stopping existing LolBot process (pid ${pid})...`);
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // Ignore
    }

    for (let i = 0; i < 10; i += 1) {
        await wait(200);
        if (!isProcessAlive(pid)) {
            return;
        }
    }

    if (isProcessAlive(pid)) {
        console.log(`[dev] Force killing process ${pid}...`);
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Ignore
        }
    }
}

function readLockPid(lockPath) {
    if (!existsSync(lockPath)) {
        return null;
    }

    try {
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        const pid = Number(parsed?.pid);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

async function stopExistingInstance() {
    const lockPath = join(resolve(root, process.env.DATA_DIR?.trim() || 'data'), 'bot.lock');
    const pid = readLockPid(lockPath);
    if (pid) {
        await stopProcess(pid);
    }
}

async function main() {
    await stopExistingInstance();

    const tsxBin = fileURLToPath(import.meta.resolve('tsx/cli'));
    const child = spawn(process.execPath, [tsxBin, 'watch', 'src/index.ts'], {
        stdio: 'inherit',
        cwd: root,
        windowsHide: true,
    });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });

    const forwardSignal = (signal) => {
        if (!child.killed) {
            child.kill(signal);
        }
    };

    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 0);
    });
}

void main();
