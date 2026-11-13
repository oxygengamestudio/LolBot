import { spawn } from 'child_process';
import { config } from '../../config.js';
import { getSafeChildEnv, getYtdlpRuntimeArgs, resolveYtdlpPath } from '../../utils/mediaProcess.js';

type PermitWaiter = {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
};

export class AsyncSemaphore {
    private available: number;
    private readonly waiters: PermitWaiter[] = [];

    constructor(private readonly capacity: number) {
        this.available = capacity;
    }

    get idle(): boolean {
        return this.available === this.capacity && this.waiters.length === 0;
    }

    async acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            throw createAbortError();
        }
        if (this.available > 0) {
            this.available -= 1;
            return this.createRelease();
        }

        return new Promise((resolve, reject) => {
            const waiter: PermitWaiter = { resolve, reject, signal };
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) {
                        this.waiters.splice(index, 1);
                    }
                    reject(createAbortError());
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }

    private createRelease(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;

            while (this.waiters.length > 0) {
                const waiter = this.waiters.shift()!;
                if (waiter.onAbort) {
                    waiter.signal?.removeEventListener('abort', waiter.onAbort);
                }
                if (waiter.signal?.aborted) {
                    waiter.reject(createAbortError());
                    continue;
                }
                waiter.resolve(this.createRelease());
                return;
            }

            this.available = Math.min(this.capacity, this.available + 1);
        };
    }
}

export function createAbortError(): Error {
    const error = new Error('Media resolution aborted');
    error.name = 'AbortError';
    return error;
}

export class YtdlpRunner {
    private readonly semaphore = new AsyncSemaphore(4);

    async runJson(args: string[], signal?: AbortSignal): Promise<unknown> {
        const payload = await this.runText(args, signal);
        const trimmed = payload.trim();
        if (!trimmed) {
            throw new Error('yt-dlp returned no JSON payload');
        }

        try {
            return JSON.parse(trimmed) as unknown;
        } catch {
            throw new Error('yt-dlp returned invalid JSON');
        }
    }

    async runText(args: string[], signal?: AbortSignal): Promise<string> {
        const release = await this.semaphore.acquire(signal);
        try {
            return await this.runTextWithPermit(args, signal);
        } finally {
            release();
        }
    }

    private runTextWithPermit(args: string[], signal?: AbortSignal): Promise<string> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }

            const ytdlp = spawn(resolveYtdlpPath(), [...getYtdlpRuntimeArgs(), ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: getSafeChildEnv(),
            });

            const timeoutMs = config.audio.ytDlpTimeoutMs;
            const killGraceMs = 2_000;
            const maxStdoutBytes = 8 * 1024 * 1024;
            const maxStderrBytes = 512 * 1024;
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;
            let terminalError: Error | undefined;
            let killTimer: NodeJS.Timeout | undefined;

            const cleanup = (): void => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
            };
            const terminate = (): void => {
                if (ytdlp.exitCode !== null || ytdlp.killed) return;
                ytdlp.kill('SIGTERM');
                killTimer = setTimeout(() => {
                    if (ytdlp.exitCode === null) ytdlp.kill('SIGKILL');
                }, killGraceMs);
                killTimer.unref?.();
            };
            const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                    return;
                }
                resolve(Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'));
            };
            const failAndTerminate = (error: Error): void => {
                if (settled || terminalError) return;
                terminalError = error;
                terminate();
                ytdlp.stdout?.resume();
                ytdlp.stderr?.resume();
            };
            const onAbort = (): void => failAndTerminate(createAbortError());
            const timeout = setTimeout(() => {
                failAndTerminate(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timeout.unref?.();

            ytdlp.stdout?.on('data', (data) => {
                if (settled || terminalError) return;
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                stdoutBytes += chunk.length;
                if (stdoutBytes > maxStdoutBytes) {
                    failAndTerminate(new Error(`yt-dlp stdout exceeded ${maxStdoutBytes} bytes`));
                    return;
                }
                stdoutChunks.push(chunk);
            });
            ytdlp.stderr?.on('data', (data) => {
                if (settled || terminalError) return;
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                stderrBytes += chunk.length;
                if (stderrBytes > maxStderrBytes) {
                    failAndTerminate(new Error(`yt-dlp stderr exceeded ${maxStderrBytes} bytes`));
                    return;
                }
                stderrChunks.push(chunk);
            });

            signal?.addEventListener('abort', onAbort, { once: true });
            ytdlp.once('error', (error) => {
                if (ytdlp.pid === undefined) finish(error);
                else failAndTerminate(error);
            });
            ytdlp.on('close', (code) => {
                if (killTimer) clearTimeout(killTimer);
                if (settled) return;
                if (terminalError) {
                    finish(terminalError);
                    return;
                }
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
                    finish(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
                    return;
                }
                finish();
            });
        });
    }

}

export const ytdlpRunner = new YtdlpRunner();
