import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

type LockPayload = {
    pid: number;
    startedAt: string;
    argv0: string;
};

export type ProcessLock = {
    path: string;
    release: () => void;
};

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return code === 'EPERM';
    }
}

function readExistingPid(lockPath: string): number | null {
    if (!existsSync(lockPath)) {
        return null;
    }

    try {
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<LockPayload>;
        return typeof parsed.pid === 'number' && parsed.pid > 0 ? parsed.pid : null;
    } catch {
        return null;
    }
}

export function acquireProcessLock(lockPath: string): ProcessLock {
    mkdirSync(dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        let fd: number | null = null;

        try {
            fd = openSync(lockPath, 'wx', 0o600);
            const payload: LockPayload = {
                pid: process.pid,
                startedAt: new Date().toISOString(),
                argv0: process.argv0,
            };
            writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');

            let released = false;
            return {
                path: lockPath,
                release: () => {
                    if (released) {
                        return;
                    }
                    released = true;

                    if (fd !== null) {
                        try {
                            closeSync(fd);
                        } catch {
                            // Ignore
                        }
                        fd = null;
                    }

                    try {
                        rmSync(lockPath, { force: true });
                    } catch {
                        // Ignore
                    }
                },
            };
        } catch (error) {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // Ignore
                }
            }

            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'EEXIST') {
                throw error;
            }

            const existingPid = readExistingPid(lockPath);
            if (existingPid && isProcessAlive(existingPid)) {
                throw new Error(`Another LolBot instance is already running (pid ${existingPid}).`);
            }

            try {
                rmSync(lockPath, { force: true });
            } catch {
                // Ignore and retry once.
            }
        }
    }

    throw new Error('Unable to acquire process lock.');
}
