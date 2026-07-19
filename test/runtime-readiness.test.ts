import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    clearRuntimeReadinessReceipt,
    RuntimeReadiness,
    type RuntimeReadinessReceipt,
    writeRuntimeReadinessReceipt,
} from '../src/runtimeReadiness.js';

const BUILD_SHA = 'a'.repeat(40);
const CHALLENGE = 'b'.repeat(64);
const FIXED_TIME = new Date('2026-07-19T04:50:00.123Z');

function createReadiness(
    output: string[],
    getBuildSha = () => BUILD_SHA,
    writeReceipt: (receipt: RuntimeReadinessReceipt) => boolean = () => true,
    clearReceipt: () => boolean = () => true
): RuntimeReadiness {
    return new RuntimeReadiness(
        getBuildSha,
        (line) => output.push(line),
        () => FIXED_TIME,
        writeReceipt,
        clearReceipt
    );
}

test('a pending console challenge is answered only after Discord Ready', () => {
    const output: string[] = [];
    const readiness = createReadiness(output);
    let ready = false;
    readiness.setDiscordReadyProbe(() => ready);

    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.deepEqual(output, []);

    ready = true;
    readiness.notifyDiscordStateChanged();
    assert.deepEqual(output, [
        `2026-07-19 04:50:00.123 INFO  [Readiness] challenge=${CHALLENGE} `
        + `build=${BUILD_SHA} discordReady=true`,
    ]);
});

test('a challenge received after Discord Ready is answered immediately', () => {
    const output: string[] = [];
    const receipts: RuntimeReadinessReceipt[] = [];
    const readiness = createReadiness(output, undefined, (receipt) => {
        receipts.push(receipt);
        return true;
    });
    readiness.setDiscordReadyProbe(() => true);

    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE.toUpperCase()}`), true);
    assert.deepEqual(output, [
        `2026-07-19 04:50:00.123 INFO  [Readiness] challenge=${CHALLENGE} `
        + `build=${BUILD_SHA} discordReady=true`,
    ]);
    assert.deepEqual(receipts, [{
        schemaVersion: 1,
        challenge: CHALLENGE,
        buildSha: BUILD_SHA,
        discordReady: true,
        generatedAt: FIXED_TIME.toISOString(),
        expiresAtMs: FIXED_TIME.getTime() + 15_000,
    }]);
});

test('invalid challenges and untrusted build identifiers cannot produce readiness', () => {
    const output: string[] = [];
    const readiness = createReadiness(output, () => `${BUILD_SHA}\nforged`);
    readiness.setDiscordReadyProbe(() => true);

    assert.equal(readiness.handleControlCommand('lolbot:ready not-a-challenge'), false);
    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.deepEqual(output, []);
});

test('a receipt write failure does not suppress websocket console readiness', () => {
    const output: string[] = [];
    const readiness = createReadiness(output, undefined, () => false);
    readiness.setDiscordReadyProbe(() => true);

    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.equal(output.length, 1);
});

test('a stale Ready observation cannot answer after the Discord client disconnects', () => {
    const output: string[] = [];
    let ready = true;
    let receiptPresent = false;
    const readiness = createReadiness(
        output,
        undefined,
        () => {
            receiptPresent = true;
            return true;
        },
        () => {
            receiptPresent = false;
            return true;
        }
    );
    readiness.setDiscordReadyProbe(() => ready);

    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.equal(receiptPresent, true);

    ready = false;
    readiness.notifyDiscordStateChanged();
    assert.equal(receiptPresent, false);
    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.equal(output.length, 1);

    ready = true;
    readiness.notifyDiscordStateChanged();
    assert.equal(output.length, 2);
    assert.equal(receiptPresent, true);
});

test('the readiness receipt is atomically replaced with private permissions', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lolbot-readiness-'));
    const receipt: RuntimeReadinessReceipt = {
        schemaVersion: 1,
        challenge: CHALLENGE,
        buildSha: BUILD_SHA,
        discordReady: true,
        generatedAt: FIXED_TIME.toISOString(),
        expiresAtMs: FIXED_TIME.getTime() + 15_000,
    };

    try {
        assert.equal(writeRuntimeReadinessReceipt(receipt, dataDir), true);
        const receiptPath = join(dataDir, 'runtime-readiness.json');
        assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')), receipt);
        assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
        assert.deepEqual(readdirSync(dataDir), ['runtime-readiness.json']);
        assert.equal(clearRuntimeReadinessReceipt(dataDir), true);
        assert.deepEqual(readdirSync(dataDir), []);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});
