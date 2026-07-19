import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDoctorChecks, formatDoctorReport, runDoctor } from '../src/doctor.js';

const successfulCommands = () => ({
    status: 0,
    stdout: 'version 1.0\nextra output',
    stderr: '',
});

test('doctor accepts the supported runtime and both Opus encoders', () => {
    const checks = collectDoctorChecks({
        nodeVersion: '24.0.0',
        runCommand: successfulCommands,
        loadModule: () => ({}),
    });

    assert.equal(checks.length, 7);
    assert.ok(checks.every((check) => check.ok));
    assert.match(formatDoctorReport(checks), /OK opus-native/);
    assert.equal(runDoctor({
        nodeVersion: '24.0.0',
        runCommand: successfulCommands,
        loadModule: () => ({}),
    }), 0);
});

test('doctor fails when a required binary is unavailable but accepts the Opus fallback', () => {
    const checks = collectDoctorChecks({
        nodeVersion: '22.12.0',
        runCommand: (command) => command === 'ffmpeg'
            ? { status: 0, stdout: 'ffmpeg 7', stderr: '' }
            : { status: null, stdout: '', stderr: 'not found', error: new Error('ENOENT') },
        loadModule: (name) => {
            if (name === '@discordjs/opus') throw new Error('module missing');
            return {};
        },
    });

    assert.equal(checks.find((check) => check.name === 'yt-dlp')?.ok, false);
    assert.equal(checks.find((check) => check.name === 'opus-native')?.ok, false);
    assert.equal(checks.find((check) => check.name === 'opus-fallback')?.ok, true);
    assert.equal(checks.find((check) => check.name === 'dave-native')?.ok, true);
    assert.equal(checks.find((check) => check.name === 'voice-crypto')?.ok, true);
    assert.equal(runDoctor({
        nodeVersion: '22.12.0',
        runCommand: successfulCommands,
        loadModule: (name) => {
            if (name === '@discordjs/opus') throw new Error('module missing');
            return {};
        },
    }), 0);
});

for (const requiredNativeModule of ['@snazzah/davey', 'sodium-native']) {
    test(`doctor rejects a runtime whose required native module ${requiredNativeModule} cannot load`, () => {
        assert.equal(runDoctor({
            nodeVersion: '24.0.0',
            runCommand: successfulCommands,
            loadModule: (name) => {
                if (name === requiredNativeModule) throw new Error('missing native compatibility');
                return {};
            },
        }), 1);
    });
}

test('doctor rejects Node versions older than the package engine floor', () => {
    const checks = collectDoctorChecks({
        nodeVersion: '22.11.0',
        runCommand: successfulCommands,
        loadModule: () => ({}),
    });

    assert.equal(checks.find((check) => check.name === 'node')?.ok, false);
});
