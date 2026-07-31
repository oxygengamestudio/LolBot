export const DISCORD_LOGIN_RETRY_POLICY = Object.freeze({
    maxAttempts: 8,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
});

const RETRYABLE_NETWORK_CODES = new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
]);

type ErrorCandidate = {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
};

export type DiscordLoginRetryEvent = {
    attempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    code: string | null;
    error: unknown;
};

export type DiscordLoginRetryOptions = Partial<typeof DISCORD_LOGIN_RETRY_POLICY> & {
    sleep?: (delayMs: number) => Promise<void>;
    random?: () => number;
    onRetry?: (event: DiscordLoginRetryEvent) => void;
};

function collectErrorCandidates(error: unknown): ErrorCandidate[] {
    const candidates: ErrorCandidate[] = [];
    const pending: unknown[] = [error];
    const visited = new Set<unknown>();

    while (pending.length > 0 && candidates.length < 16) {
        const value = pending.shift();
        if (!value || (typeof value !== 'object' && typeof value !== 'function') || visited.has(value)) {
            continue;
        }

        visited.add(value);
        const candidate = value as ErrorCandidate;
        candidates.push(candidate);
        if (candidate.cause) pending.push(candidate.cause);
        if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
    }

    return candidates;
}

export function getDiscordLoginErrorCode(error: unknown): string | null {
    for (const candidate of collectErrorCandidates(error)) {
        if (candidate.code !== undefined && candidate.code !== null) {
            return String(candidate.code);
        }

        if (typeof candidate.message === 'string') {
            const match = candidate.message.match(/\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/);
            if (match) return match[0];
        }
    }

    return null;
}

export function isRetryableDiscordLoginError(error: unknown): boolean {
    for (const candidate of collectErrorCandidates(error)) {
        const code = candidate.code === undefined || candidate.code === null
            ? null
            : String(candidate.code);
        if (code && RETRYABLE_NETWORK_CODES.has(code)) {
            return true;
        }

        const statusValue = candidate.status ?? candidate.statusCode ?? candidate.httpStatus;
        const status = typeof statusValue === 'number' ? statusValue : Number(statusValue);
        if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
            return true;
        }

        if (typeof candidate.message === 'string') {
            for (const retryableCode of RETRYABLE_NETWORK_CODES) {
                if (candidate.message.includes(retryableCode)) {
                    return true;
                }
            }
        }
    }

    return false;
}

export function discordLoginRetryDelayMs(
    failedAttempt: number,
    options: Pick<DiscordLoginRetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'random'> = {}
): number {
    const baseDelayMs = options.baseDelayMs ?? DISCORD_LOGIN_RETRY_POLICY.baseDelayMs;
    const maxDelayMs = options.maxDelayMs ?? DISCORD_LOGIN_RETRY_POLICY.maxDelayMs;
    const jitterRatio = options.jitterRatio ?? DISCORD_LOGIN_RETRY_POLICY.jitterRatio;
    const random = options.random ?? Math.random;
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failedAttempt - 1));
    const jitter = Math.floor(exponentialDelay * Math.max(0, jitterRatio) * Math.max(0, Math.min(1, random())));
    return exponentialDelay + jitter;
}

export async function loginDiscordWithRetry(
    login: () => Promise<string>,
    options: DiscordLoginRetryOptions = {}
): Promise<string> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DISCORD_LOGIN_RETRY_POLICY.maxAttempts));
    const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    }));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await login();
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryableDiscordLoginError(error)) {
                throw error;
            }

            const delayMs = discordLoginRetryDelayMs(attempt, options);
            options.onRetry?.({
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts,
                delayMs,
                code: getDiscordLoginErrorCode(error),
                error,
            });
            await sleep(delayMs);
        }
    }

    throw new Error('Discord login retry loop exhausted unexpectedly');
}
