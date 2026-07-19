import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDoctorChecks, formatDoctorReport, runDoctor } from '../src/doctor.js';

const successfulCommands = () => ({
    status: 0,
    stdout: 'version 1.0\nextra output',
    stderr: '',
});

function successfulModule(name: string): unknown {
    if (name === '@noble/ciphers/chacha.js') {
        return {
            xchacha20poly1305: () => ({
                encrypt: (plaintext: Uint8Array) => Uint8Array.from([...plaintext, 0xaa]),
                decrypt: (ciphertext: Uint8Array) => ciphertext.slice(0, -1),
            }),
        };
    }
    return {};
}

test('doctor accepts the supported runtime and both Opus encoders', async () => {
    const checks = await collectDoctorChecks({
        nodeVersion: '24.0.0',
        runCommand: successfulCommands,
        loadModule: successfulModule,
    });

    assert.equal(checks.length, 7);
    assert.ok(checks.every((check) => check.ok));
    assert.match(formatDoctorReport(checks), /OK opus-native/);
    assert.equal(await runDoctor({
        nodeVersion: '24.0.0',
        runCommand: successfulCommands,
        loadModule: successfulModule,
    }), 0);
});

test('doctor fails when a required binary is unavailable but accepts the Opus fallback', async () => {
    const checks = await collectDoctorChecks({
        nodeVersion: '22.12.0',
        runCommand: (command) => command === 'ffmpeg'
            ? { status: 0, stdout: 'ffmpeg 7', stderr: '' }
            : { status: null, stdout: '', stderr: 'not found', error: new Error('ENOENT') },
        loadModule: (name) => {
            if (name === '@discordjs/opus') throw new Error('module missing');
            return successfulModule(name);
        },
    });

    assert.equal(checks.find((check) => check.name === 'yt-dlp')?.ok, false);
    assert.equal(checks.find((check) => check.name === 'opus-native')?.ok, false);
    assert.equal(checks.find((check) => check.name === 'opus-fallback')?.ok, true);
    assert.equal(checks.find((check) => check.name === 'dave-native')?.ok, true);
    assert.equal(checks.find((check) => check.name === 'voice-crypto')?.ok, true);
    assert.equal(await runDoctor({
        nodeVersion: '22.12.0',
        runCommand: successfulCommands,
        loadModule: (name) => {
            if (name === '@discordjs/opus') throw new Error('module missing');
            return successfulModule(name);
        },
    }), 0);
});

for (const requiredVoiceModule of ['@snazzah/davey', '@noble/ciphers/chacha.js']) {
    test(`doctor rejects a runtime whose required voice module ${requiredVoiceModule} cannot load`, async () => {
        assert.equal(await runDoctor({
            nodeVersion: '24.0.0',
            runCommand: successfulCommands,
            loadModule: (name) => {
                if (name === requiredVoiceModule) throw new Error('missing voice compatibility');
                return successfulModule(name);
            },
        }), 1);
    });
}

test('doctor rejects a broken XChaCha20-Poly1305 backend', async () => {
    assert.equal(await runDoctor({
        nodeVersion: '24.0.0',
        runCommand: successfulCommands,
        loadModule: (name) => name === '@noble/ciphers/chacha.js'
            ? {
                xchacha20poly1305: () => ({
                    encrypt: (plaintext: Uint8Array) => plaintext,
                    decrypt: () => Uint8Array.from([0xff]),
                }),
            }
            : successfulModule(name),
    }), 1);
});

test('doctor rejects Node versions older than the package engine floor', async () => {
    const checks = await collectDoctorChecks({
        nodeVersion: '22.11.0',
        runCommand: successfulCommands,
        loadModule: successfulModule,
    });

    assert.equal(checks.find((check) => check.name === 'node')?.ok, false);
});
