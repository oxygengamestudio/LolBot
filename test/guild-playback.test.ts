import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    applyPlaybackTransition,
    canBeginPlayback,
    canTransition,
    isPlaybackActive,
} from '../src/services/GuildPlayback.js';
import type { PauseReason, PlaybackStatus, Track } from '../src/types/index.js';

const ALL: PlaybackStatus[] = ['idle', 'starting', 'playing', 'paused', 'stopping'];

function state(playback: PlaybackStatus, pauseReason: PauseReason | null = null) {
    return { playback, pauseReason, currentTrack: null as Track | null };
}

test('the transition table allows exactly the documented playback moves', () => {
    const allowed = new Set([
        'idle>starting', 'idle>stopping',
        'starting>playing', 'starting>idle', 'starting>stopping',
        'playing>paused', 'playing>idle', 'playing>stopping',
        'paused>playing', 'paused>idle', 'paused>stopping',
        'stopping>idle', 'stopping>starting',
    ]);
    for (const from of ALL) {
        for (const to of ALL) {
            assert.equal(canTransition(from, to), from === to || allowed.has(`${from}>${to}`), `${from} -> ${to}`);
        }
    }
});

test('an unexpected transition is applied but reported', () => {
    const queue = state('idle');
    assert.deepEqual(applyPlaybackTransition(queue, 'playing'), { previous: 'idle', expected: false });
    assert.equal(queue.playback, 'playing');
});

test('the pause reason exists only while paused and survives a repeated pause', () => {
    const queue = state('playing');
    applyPlaybackTransition(queue, 'paused', 'empty_channel');
    assert.equal(queue.pauseReason, 'empty_channel');

    applyPlaybackTransition(queue, 'paused', 'user');
    assert.equal(queue.pauseReason, 'empty_channel', 'un second événement Paused ne réécrit pas la raison');

    applyPlaybackTransition(queue, 'playing');
    assert.equal(queue.pauseReason, null);
});

test('only an idle or stopping guild without a current track may begin playback', () => {
    for (const playback of ALL) {
        assert.equal(canBeginPlayback(state(playback)), playback === 'idle' || playback === 'stopping', playback);
        assert.equal(isPlaybackActive(state(playback)), playback === 'playing' || playback === 'paused', playback);
    }
    assert.equal(canBeginPlayback({ ...state('idle'), currentTrack: {} as Track }), false);
});
