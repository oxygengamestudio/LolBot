import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DISCORD_LOGIN_RETRY_POLICY,
    discordLoginRetryDelayMs,
    isRetryableDiscordLoginError,
    loginDiscordWithRetry,
} from '../src/utils/discordLogin.js';

test('Discord login retries a transient DNS failure and eventually succeeds', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retryCodes: Array<string | null> = [];

    const result = await loginDiscordWithRetry(async () => {
        attempts += 1;
        if (attempts < 3) {
            throw Object.assign(new Error('getaddrinfo EAI_AGAIN discord.com'), { code: 'EAI_AGAIN' });
        }
        return 'discord-token-redacted';
    }, {
        maxAttempts: 4,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0,
        sleep: async (delayMs) => { delays.push(delayMs); },
        onRetry: (event) => { retryCodes.push(event.code); },
    });

    assert.equal(result, 'discord-token-redacted');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.deepEqual(retryCodes, ['EAI_AGAIN', 'EAI_AGAIN']);
});

test('Discord login does not retry invalid credentials', async () => {
    let attempts = 0;
    const invalidToken = Object.assign(new Error('An invalid token was provided'), { code: 'TokenInvalid' });

    await assert.rejects(
        loginDiscordWithRetry(async () => {
            attempts += 1;
            throw invalidToken;
        }, {
            sleep: async () => assert.fail('a non-network error must not sleep'),
        }),
        invalidToken
    );
    assert.equal(attempts, 1);
});

test('nested network errors and retryable HTTP failures are recognized', () => {
    assert.equal(isRetryableDiscordLoginError({ cause: { code: 'ECONNRESET' } }), true);
    assert.equal(isRetryableDiscordLoginError({ status: 503 }), true);
    assert.equal(isRetryableDiscordLoginError({ status: 401, code: 'TokenInvalid' }), false);
});

test('the default retry window keeps the first process alive for at least two minutes', () => {
    let minimumRetryWindowMs = 0;
    for (let failedAttempt = 1; failedAttempt < DISCORD_LOGIN_RETRY_POLICY.maxAttempts; failedAttempt += 1) {
        minimumRetryWindowMs += discordLoginRetryDelayMs(failedAttempt, { random: () => 0 });
    }

    assert.equal(minimumRetryWindowMs, 120_000);
});
