import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeReadiness } from '../src/runtimeReadiness.js';

const BUILD_SHA = 'a'.repeat(40);
const CHALLENGE = 'b'.repeat(64);
const FIXED_TIME = new Date('2026-07-19T04:50:00.123Z');

function createReadiness(output: string[], getBuildSha = () => BUILD_SHA): RuntimeReadiness {
    return new RuntimeReadiness(
        getBuildSha,
        (line) => output.push(line),
        () => FIXED_TIME
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
    const readiness = createReadiness(output);
    readiness.setDiscordReadyProbe(() => true);

    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE.toUpperCase()}`), true);
    assert.deepEqual(output, [
        `2026-07-19 04:50:00.123 INFO  [Readiness] challenge=${CHALLENGE} `
        + `build=${BUILD_SHA} discordReady=true`,
    ]);
});

test('invalid challenges and untrusted build identifiers cannot produce readiness', () => {
    const output: string[] = [];
    const readiness = createReadiness(output, () => `${BUILD_SHA}\nforged`);
    readiness.setDiscordReadyProbe(() => true);

    assert.equal(readiness.handleControlCommand('lolbot:ready not-a-challenge'), false);
    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.deepEqual(output, []);
});

test('a stale Ready observation cannot answer after the Discord client disconnects', () => {
    const output: string[] = [];
    let ready = true;
    const readiness = createReadiness(output);
    readiness.setDiscordReadyProbe(() => ready);

    ready = false;
    assert.equal(readiness.handleControlCommand(`lolbot:ready ${CHALLENGE}`), true);
    assert.deepEqual(output, []);

    ready = true;
    readiness.notifyDiscordStateChanged();
    assert.equal(output.length, 1);
});
