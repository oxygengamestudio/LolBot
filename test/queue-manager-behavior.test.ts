import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Track } from '../src/types/index.js';

const testDataDir = join(tmpdir(), `lolbot-queue-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;

class FakeAudioPlayer extends EventEmitter {
    state: Record<string, unknown> = { status: 'idle' };
    private readonly startAutomatically: boolean;

    constructor(startAutomatically: boolean) {
        super();
        this.startAutomatically = startAutomatically;
    }

    play(resource: unknown): void {
        this.transition('buffering', resource);
        if (this.startAutomatically) {
            setImmediate(() => this.transition('playing', resource));
        }
    }

    transition(status: string, resource = this.state.resource): void {
        const oldState = this.state;
        this.state = resource ? { status, resource } : { status };
        this.emit('stateChange', oldState, this.state);
        this.emit(status, oldState, this.state);
    }

    stop(): boolean {
        const oldState = this.state;
        this.state = { status: 'idle' };
        this.emit('stateChange', oldState, this.state);
        this.emit('idle', oldState, this.state);
        return true;
    }

    pause(): boolean { return true; }
    unpause(): boolean { return true; }
}

class FakeVoiceConnection extends EventEmitter {
    state = { status: 'ready' };
    rejoinAttempts = 0;
    destroyCalls = 0;
    subscribeCalls = 0;

    transition(status: string): void {
        const oldState = this.state;
        this.state = { status };
        this.emit('stateChange', oldState, this.state);
        this.emit(status, oldState, this.state);
    }

    subscribe(): object {
        this.subscribeCalls += 1;
        return {};
    }

    destroy(): void {
        this.destroyCalls += 1;
        this.transition('destroyed');
    }
}

function track(id: string): Track {
    return {
        id,
        provider: 'youtube',
        sourceId: id,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
        title: `Track ${id}`,
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: 180,
        thumbnail: '',
        requestedBy: 'Tester',
        requestedById: '200000000000000001',
    };
}

function resource(trackId: string, createdAt = Date.now()) {
    return {
        metadata: { trackId, createdAt, startSeconds: 0 },
        playbackDuration: 0,
        volume: { setVolume: () => undefined },
        playStream: { destroy: () => undefined },
    };
}

let modules: Awaited<ReturnType<typeof loadModules>>;
let restore: (() => void) | undefined;

async function loadModules() {
    const queueModule = await import('../src/services/QueueManager.js');
    const { audioWrapper } = await import('../src/audio/AudioWrapper.js');
    const { mediaCacheManager } = await import('../src/audio/MediaCacheManager.js');
    const { guildSettingsManager } = await import('../src/services/GuildSettingsManager.js');
    return { queueModule, audioWrapper, mediaCacheManager, guildSettingsManager };
}

function installIsolatedDoubles() {
    const wrapper = modules.audioWrapper as any;
    const cache = modules.mediaCacheManager as any;
    const settings = modules.guildSettingsManager as any;
    const originals = {
        cleanupGuildTemp: wrapper.cleanupGuildTemp,
        createResource: wrapper.createResource,
        isTrackWarm: wrapper.isTrackWarm,
        getLastSourceMode: wrapper.getLastSourceMode,
        clearFromCache: wrapper.clearFromCache,
        preloadTracks: wrapper.preloadTracks,
        warmTrack: wrapper.warmTrack,
        cancelGuildWarmups: wrapper.cancelGuildWarmups,
        clearWarmResource: wrapper.clearWarmResource,
        teardownResource: wrapper.teardownResource,
        clearUnused: cache.clearUnused,
        getSettings: settings.getSettings,
    };

    wrapper.cleanupGuildTemp = async () => undefined;
    wrapper.isTrackWarm = () => false;
    wrapper.getLastSourceMode = () => 'direct';
    wrapper.clearFromCache = () => undefined;
    wrapper.preloadTracks = async () => undefined;
    wrapper.warmTrack = async () => null;
    wrapper.cancelGuildWarmups = async () => undefined;
    wrapper.clearWarmResource = () => undefined;
    wrapper.teardownResource = () => undefined;
    cache.clearUnused = async () => undefined;
    settings.getSettings = async (guildId: string) => ({
        guildId,
        locale: 'fr',
        volume: 100,
        stayConnected: true,
        stayConnectedAlways: false,
        pauseOnEmptyChannelWhenAlwaysConnected: false,
        crossfadeEnabled: false,
        sponsorBlockEnabled: false,
        preferredVoiceChannel: null,
        voiceChannelMode: 'allow_all',
        allowedVoiceChannels: [],
        blockedVoiceChannels: [],
        rolePermissionMode: 'allow_all',
        allowedRoles: [],
        blockedRoles: [],
    });

    return () => Object.assign(wrapper, {
        cleanupGuildTemp: originals.cleanupGuildTemp,
        createResource: originals.createResource,
        isTrackWarm: originals.isTrackWarm,
        getLastSourceMode: originals.getLastSourceMode,
        clearFromCache: originals.clearFromCache,
        preloadTracks: originals.preloadTracks,
        warmTrack: originals.warmTrack,
        cancelGuildWarmups: originals.cancelGuildWarmups,
        clearWarmResource: originals.clearWarmResource,
        teardownResource: originals.teardownResource,
    }) && Object.assign(cache, { clearUnused: originals.clearUnused })
        && Object.assign(settings, { getSettings: originals.getSettings });
}

function createQueue(guildId: string, player: FakeAudioPlayer) {
    const manager = modules.queueModule.queueManager as any;
    const queue = manager.createQueue(
        guildId,
        { id: `text-${guildId}`, name: 'test-text' },
        {
            id: `voice-${guildId}`,
            name: 'test-voice',
            guild: { voiceAdapterCreator: {} },
            members: { filter: () => ({ size: 1 }) },
        }
    );
    queue.player = player;
    queue.connection = {
        state: { status: 'ready' },
        subscribe: () => ({}),
        destroy: () => undefined,
    };
    return queue;
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    modules = await loadModules();
    restore = installIsolatedDoubles();
});

after(async () => {
    const manager = modules.queueModule.queueManager as any;
    for (const runtime of manager.runtimes.values()) {
        if (runtime.bufferingWatchdog) clearTimeout(runtime.bufferingWatchdog);
        for (const timer of runtime.retiredResources.values()) clearTimeout(timer);
    }
    manager.queues.clear();
    restore?.();
    await rm(testDataDir, { recursive: true, force: true });
});

test('playNext resolves as started only after the player reaches Playing', async () => {
    const manager = modules.queueModule.queueManager as any;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-playing-confirmation', player);
    const selectedTrack = track('confirmed');
    const selectedResource = resource(selectedTrack.id);
    queue.tracks.push(selectedTrack);
    modules.audioWrapper.createResource = async () => selectedResource as never;

    let settled = false;
    const start = manager.playNext(queue.guildId).then((result: unknown) => {
        settled = true;
        return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(queue.currentTrack, null, 'la piste ne doit pas être publiée avant Playing');

    player.transition('playing', selectedResource);
    const result = await start;
    assert.deepEqual(result, { status: 'started', track: selectedTrack });
    assert.equal(manager.runtime(queue.guildId).activeResource, selectedResource);
});

test('playNext consumes a prepared warmup instead of cancelling it between tracks', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-warmup-consumption', player);
    const selectedTrack = track('prepared');
    queue.tracks.push(selectedTrack);
    let cleanupCalls = 0;
    wrapper.cleanupGuildTemp = async () => { cleanupCalls += 1; };
    wrapper.isTrackWarm = (guildId: string, trackId: string) =>
        guildId === queue.guildId && trackId === selectedTrack.id;
    wrapper.createResource = async () => resource(selectedTrack.id) as never;

    try {
        const result = await manager.playNext(queue.guildId);
        assert.equal(result.status, 'started');
        assert.equal(queue.lastStartMetrics?.warmHit, true);
        assert.equal(cleanupCalls, 0, 'la préparation ne doit pas être annulée avant sa consommation');
    } finally {
        wrapper.cleanupGuildTemp = async () => undefined;
        wrapper.isTrackWarm = () => false;
    }
});

test('the 15 second start watchdog is retryable and retries the source exactly once', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalTimeout = manager.playbackStartTimeoutMs;
    manager.playbackStartTimeoutMs = 20;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-start-watchdog', player);
    const selectedTrack = track('timeout');
    queue.tracks.push(selectedTrack);
    let resourceAttempts = 0;
    modules.audioWrapper.createResource = async () => {
        resourceAttempts += 1;
        return resource(selectedTrack.id, Date.now() + resourceAttempts) as never;
    };

    try {
        const result = await manager.playNext(queue.guildId);
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'start_timeout');
        assert.equal(result.retryable, true);
        assert.equal(resourceAttempts, 2);
        assert.equal(queue.currentTrack, null);
    } finally {
        manager.playbackStartTimeoutMs = originalTimeout;
    }
});

test('deleting a queue invalidates an in-flight source resolution without stale state', async () => {
    const manager = modules.queueModule.queueManager as any;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-session-invalidation', player);
    const selectedTrack = track('cancelled');
    queue.tracks.push(selectedTrack);
    let resolveResource!: (value: unknown) => void;
    modules.audioWrapper.createResource = () => new Promise((resolve) => { resolveResource = resolve; }) as never;

    const start = manager.playNext(queue.guildId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.deleteQueue(queue.guildId, true);
    resolveResource(resource(selectedTrack.id));

    const result = await start;
    assert.deepEqual(result, {
        status: 'failed',
        code: 'cancelled',
        retryable: true,
        track: selectedTrack,
    });
    assert.equal(manager.getQueue(queue.guildId), undefined);
});

test('a seek completed after /leave destroys its stale resource without reinstalling playback', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const originalTeardownResource = wrapper.teardownResource;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-seek-leave-race', player);
    const selectedTrack = track('seek-before-leave');
    const staleSeekResource = resource(selectedTrack.id, 40);
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';

    let seekStarted = false;
    let resolveSeek!: (value: unknown) => void;
    const tornDown: unknown[] = [];
    wrapper.createResource = () => {
        seekStarted = true;
        return new Promise((resolve) => { resolveSeek = resolve; });
    };
    wrapper.teardownResource = (value: unknown) => { tornDown.push(value); };

    try {
        const seek = manager.seekTo(queue.guildId, 30);
        const deadline = Date.now() + 250;
        while (!seekStarted && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(seekStarted, true, 'la recréation audio du seek doit avoir commencé');

        manager.deleteQueue(queue.guildId, true);
        resolveSeek(staleSeekResource);

        assert.equal(await seek, false);
        assert.ok(tornDown.includes(staleSeekResource));
        assert.equal(manager.getQueue(queue.guildId), undefined);
        assert.notEqual(manager.runtime(queue.guildId).activeResource, staleSeekResource);
        assert.equal(player.state.status, 'idle');
    } finally {
        wrapper.createResource = originalCreateResource;
        wrapper.teardownResource = originalTeardownResource;
    }
});

test('a current seek still installs the requested resource and preserves the active track', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-seek-current', player);
    const selectedTrack = track('seek-current');
    const selectedResource = resource(selectedTrack.id, 41);
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    wrapper.createResource = async () => selectedResource as never;

    try {
        assert.equal(await manager.seekTo(queue.guildId, 30), true);
        assert.equal(queue.currentTrack, selectedTrack);
        assert.equal(manager.runtime(queue.guildId).activeResource, selectedResource);
        assert.equal(player.state.status, 'playing');
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
    }
});

test('a seek watchdog tears down a resource that never reaches Playing', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const originalTeardownResource = wrapper.teardownResource;
    const originalTimeout = manager.playbackStartTimeoutMs;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-seek-watchdog', player);
    const selectedTrack = track('seek-watchdog');
    const selectedResource = resource(selectedTrack.id, 42);
    const tornDown: unknown[] = [];
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    manager.playbackStartTimeoutMs = 20;
    wrapper.createResource = async () => selectedResource as never;
    wrapper.teardownResource = (value: unknown) => { tornDown.push(value); };

    try {
        assert.equal(await manager.seekTo(queue.guildId, 30), false);
        assert.ok(tornDown.includes(selectedResource));
        assert.notEqual(manager.runtime(queue.guildId).activeResource, selectedResource);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        manager.playbackStartTimeoutMs = originalTimeout;
        wrapper.createResource = originalCreateResource;
        wrapper.teardownResource = originalTeardownResource;
    }
});

test('seek refuses to supersede an active voice reconnection', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-seek-reconnecting', player);
    queue.currentTrack = track('seek-reconnecting');
    queue.playback = 'playing';
    queue.isReconnecting = true;
    let resourceCalls = 0;
    wrapper.createResource = async () => {
        resourceCalls += 1;
        return resource(queue.currentTrack.id) as never;
    };

    try {
        assert.equal(await manager.seekTo(queue.guildId, 30), false);
        assert.equal(resourceCalls, 0);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
    }
});

test('/stop invalidates a start awaiting Playing and leaves no track behind', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalTimeout = manager.playbackStartTimeoutMs;
    manager.playbackStartTimeoutMs = 30;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-stop-race', player);
    const selectedTrack = track('stopped-before-playing');
    queue.tracks.push(selectedTrack);
    modules.audioWrapper.createResource = async () => resource(selectedTrack.id) as never;

    try {
        const start = manager.playNext(queue.guildId);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.stop(queue.guildId), true);
        const result = await start;

        assert.equal(result.status, 'failed');
        assert.equal(queue.currentTrack, null);
        assert.deepEqual(queue.tracks, []);
        assert.match(queue.playback, /^(stopping|idle)$/);
    } finally {
        manager.playbackStartTimeoutMs = originalTimeout;
    }
});

test('two guilds can confirm playback concurrently without sharing state', async () => {
    const manager = modules.queueModule.queueManager as any;
    const playerA = new FakeAudioPlayer(false);
    const playerB = new FakeAudioPlayer(false);
    const queueA = createQueue('guild-concurrent-a', playerA);
    const queueB = createQueue('guild-concurrent-b', playerB);
    const trackA = track('concurrent-a');
    const trackB = track('concurrent-b');
    queueA.tracks.push(trackA);
    queueB.tracks.push(trackB);
    const resources = new Map([
        [trackA.id, resource(trackA.id)],
        [trackB.id, resource(trackB.id)],
    ]);
    modules.audioWrapper.createResource = async (_guildId: string, selectedTrack: Track) =>
        resources.get(selectedTrack.id) as never;

    const startA = manager.playNext(queueA.guildId);
    const startB = manager.playNext(queueB.guildId);
    await new Promise((resolve) => setImmediate(resolve));
    playerB.transition('playing', resources.get(trackB.id));
    playerA.transition('playing', resources.get(trackA.id));

    const [resultA, resultB] = await Promise.all([startA, startB]);
    assert.equal(resultA.status, 'started');
    assert.equal(resultB.status, 'started');
    assert.equal(queueA.currentTrack, trackA);
    assert.equal(queueB.currentTrack, trackB);
    assert.notEqual(
        manager.runtime(queueA.guildId).activeResource,
        manager.runtime(queueB.guildId).activeResource
    );
});

for (const guildCount of [10, 25]) {
    test(`${guildCount} guild playback starts remain isolated`, async () => {
        const manager = modules.queueModule.queueManager as any;
        const fixtures = Array.from({ length: guildCount }, (_, index) => {
            const selectedTrack = track(`scale-${guildCount}-${index}`);
            const selectedResource = resource(selectedTrack.id, Date.now() + index);
            const player = new FakeAudioPlayer(false);
            const queue = createQueue(`guild-scale-${guildCount}-${index}`, player);
            queue.tracks.push(selectedTrack);
            return { queue, player, selectedTrack, selectedResource };
        });
        const resources = new Map(fixtures.map((fixture) => [fixture.selectedTrack.id, fixture.selectedResource]));
        modules.audioWrapper.createResource = async (_guildId: string, selectedTrack: Track) =>
            resources.get(selectedTrack.id) as never;

        const starts = fixtures.map((fixture) => manager.playNext(fixture.queue.guildId));
        await new Promise((resolve) => setImmediate(resolve));
        for (const fixture of [...fixtures].reverse()) {
            fixture.player.transition('playing', fixture.selectedResource);
        }
        const results = await Promise.all(starts);

        assert.ok(results.every((result) => result.status === 'started'));
        for (const fixture of fixtures) {
            assert.equal(fixture.queue.currentTrack, fixture.selectedTrack);
            assert.equal(manager.runtime(fixture.queue.guildId).activeResource, fixture.selectedResource);
        }
        assert.equal(new Set(fixtures.map((fixture) => fixture.queue.currentTrack?.id)).size, guildCount);
    });
}

test('a ready next source is handed to the player within the 40ms gapless budget', async () => {
    const manager = modules.queueModule.queueManager as any;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-gapless-transition', player);
    const previousTrack = track('gapless-previous');
    const nextTrack = track('gapless-next');
    const previousResource = resource(previousTrack.id);
    const nextResource = resource(nextTrack.id, Date.now() + 1);
    queue.currentTrack = previousTrack;
    queue.playback = 'playing';
    queue.startedAt = Date.now() - 1000;
    queue.tracks.push(nextTrack);
    manager.runtime(queue.guildId).activeResource = previousResource;
    modules.audioWrapper.createResource = async () => nextResource as never;

    let playCalledAt = 0;
    const originalPlay = player.play.bind(player);
    player.play = (value: unknown) => {
        playCalledAt = Date.now();
        originalPlay(value);
        setImmediate(() => player.transition('playing', value));
    };

    const endedAt = Date.now();
    manager.handleTrackEnd(queue);
    const deadline = Date.now() + 250;
    while (playCalledAt === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }

    assert.ok(playCalledAt > 0, 'la ressource suivante prête doit être remise au player');
    assert.ok(playCalledAt - endedAt < 40, `transition mesurée à ${playCalledAt - endedAt}ms`);
});

test('events from a retired resource are identifiable and do not match the replacement', () => {
    const manager = modules.queueModule.queueManager as any;
    const guildId = 'guild-retired-resource';
    const retired = resource('same-track', 100);
    const replacement = resource('same-track', 200);

    manager.runtime(guildId).activeResource = retired;
    manager.teardownActiveResource(guildId);

    assert.equal(manager.shouldIgnorePlayerResourceError(guildId, retired), true);
    assert.equal(manager.shouldIgnorePlayerResourceError(guildId, replacement), false);
    manager.clearRetiredResources(guildId);
});

test('a buffering watchdog attempts bounded recovery at the current position', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalTimeout = manager.bufferingTimeoutMs;
    const originalResume = manager.resumeCurrentTrack;
    const originalHandleEnd = manager.handleTrackEnd;
    manager.bufferingTimeoutMs = 15;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-buffering-watchdog', player);
    const selectedTrack = track('buffering');
    const selectedResource = resource(selectedTrack.id);
    queue.currentTrack = selectedTrack;
    queue.startedAt = Date.now() - 7_000;
    player.state = { status: 'buffering', resource: selectedResource };
    manager.runtime(queue.guildId).activeResource = selectedResource;
    const recoveredOffsets: number[] = [];
    let ended = 0;
    manager.resumeCurrentTrack = async (_queue: unknown, offset: number) => {
        recoveredOffsets.push(offset);
        return false;
    };
    manager.handleTrackEnd = () => { ended += 1; };

    try {
        manager.startBufferingWatchdog(queue);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(recoveredOffsets.length, 1);
        assert.ok((recoveredOffsets[0] ?? 0) >= 6);
        assert.equal(ended, 1);
    } finally {
        manager.clearBufferingWatchdog(queue.guildId);
        manager.resumeCurrentTrack = originalResume;
        manager.handleTrackEnd = originalHandleEnd;
        manager.bufferingTimeoutMs = originalTimeout;
    }
});

test('a buffering recovery completed after /stop destroys its stale resource without reinstalling it', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalTimeout = manager.bufferingTimeoutMs;
    const originalCreateResource = wrapper.createResource;
    const originalTeardownResource = wrapper.teardownResource;
    manager.bufferingTimeoutMs = 5;

    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-buffering-stop-race', player);
    const selectedTrack = track('buffering-stop-race');
    const selectedResource = resource(selectedTrack.id, 10);
    const staleRecoveryResource = resource(selectedTrack.id, 20);
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    queue.startedAt = Date.now() - 4_000;
    player.state = { status: 'buffering', resource: selectedResource };
    manager.runtime(queue.guildId).activeResource = selectedResource;

    let recoveryStarted = false;
    let resolveRecovery!: (value: unknown) => void;
    const tornDown: unknown[] = [];
    wrapper.createResource = () => {
        recoveryStarted = true;
        return new Promise((resolve) => { resolveRecovery = resolve; });
    };
    wrapper.teardownResource = (value: unknown) => { tornDown.push(value); };

    try {
        manager.startBufferingWatchdog(queue);
        const deadline = Date.now() + 250;
        while (!recoveryStarted && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(recoveryStarted, true, 'la reprise doit avoir commencé avant le stop');

        assert.equal(manager.stop(queue.guildId), true);
        resolveRecovery(staleRecoveryResource);
        await new Promise((resolve) => setTimeout(resolve, 15));

        assert.ok(tornDown.includes(staleRecoveryResource), 'la ressource produite par l’ancienne session doit être détruite');
        assert.notEqual(manager.runtime(queue.guildId).activeResource, staleRecoveryResource);
        assert.equal(queue.currentTrack, null);
        assert.equal(player.state.status, 'idle');
    } finally {
        manager.clearBufferingWatchdog(queue.guildId);
        manager.bufferingTimeoutMs = originalTimeout;
        wrapper.createResource = originalCreateResource;
        wrapper.teardownResource = originalTeardownResource;
    }
});

test('a reconnect resume completed after /stop cannot reinstall stale playback', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalJoinChannel = manager.joinChannel;
    const originalCreateResource = wrapper.createResource;
    const originalTeardownResource = wrapper.teardownResource;

    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-reconnect-stop-race', player);
    const selectedTrack = track('reconnect-stop-race');
    const staleRecoveryResource = resource(selectedTrack.id, 30);
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    queue.startedAt = Date.now() - 8_000;
    manager.runtime(queue.guildId).activeResource = null;

    const recoveredConnection = {
        state: { status: 'ready' },
        subscribe: () => ({}),
        destroy: () => undefined,
    };
    manager.joinChannel = async () => {
        queue.connection = recoveredConnection;
        return recoveredConnection;
    };

    let recoveryStarted = false;
    let resolveRecovery!: (value: unknown) => void;
    const tornDown: unknown[] = [];
    wrapper.createResource = () => {
        recoveryStarted = true;
        return new Promise((resolve) => { resolveRecovery = resolve; });
    };
    wrapper.teardownResource = (value: unknown) => { tornDown.push(value); };

    try {
        const reconnect = manager.reconnectWithBackoff(queue, 8);
        const deadline = Date.now() + 250;
        while (!recoveryStarted && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(recoveryStarted, true, 'la recréation audio de reconnexion doit avoir commencé');

        assert.equal(manager.stop(queue.guildId), true);
        resolveRecovery(staleRecoveryResource);

        assert.equal(await reconnect, false);
        assert.ok(tornDown.includes(staleRecoveryResource));
        assert.notEqual(manager.runtime(queue.guildId).activeResource, staleRecoveryResource);
        assert.equal(queue.currentTrack, null);
    } finally {
        manager.joinChannel = originalJoinChannel;
        wrapper.createResource = originalCreateResource;
        wrapper.teardownResource = originalTeardownResource;
    }
});

for (const mode of ['stayConnected', 'stayConnectedAlways'] as const) {
    test(`an empty queue preserves and recovers its ${mode} voice connection`, async () => {
        const manager = modules.queueModule.queueManager as any;
        const settings = modules.guildSettingsManager as any;
        const originalSettings = settings.getSettings;
        const originalJoin = manager.joinChannel;
        const queue = createQueue(`guild-empty-${mode}`, new FakeAudioPlayer(false));
        const connection = new FakeVoiceConnection();
        const replacement = new FakeVoiceConnection();
        queue.connection = connection;
        let joins = 0;
        settings.getSettings = async (guildId: string) => ({
            ...await originalSettings(guildId),
            stayConnected: mode === 'stayConnected',
            stayConnectedAlways: mode === 'stayConnectedAlways',
        });
        manager.joinChannel = async () => {
            joins += 1;
            queue.connection = replacement;
            return replacement;
        };

        try {
            assert.deepEqual(await manager.playNext(queue.guildId), { status: 'queue_empty' });
            assert.equal(queue.shouldKeepConnection, true);
            assert.equal(manager.getQueue(queue.guildId), queue);
            assert.equal(await manager.reconnectWithBackoff(queue, 0), true);
            assert.equal(joins, 1, 'la connexion doit être rétablie même sans piste');
            assert.equal(connection.destroyCalls, 1);
            assert.equal(queue.connection, replacement);
            assert.equal(queue.currentTrack, null);
        } finally {
            manager.deleteQueue(queue.guildId, true);
            settings.getSettings = originalSettings;
            manager.joinChannel = originalJoin;
        }
    });
}

test('an empty queue still disconnects when both stay-connected options are disabled', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const queue = createQueue('guild-empty-disconnect', new FakeAudioPlayer(false));
    const connection = new FakeVoiceConnection();
    queue.connection = connection;
    settings.getSettings = async (guildId: string) => ({
        ...await originalSettings(guildId),
        stayConnected: false,
        stayConnectedAlways: false,
    });

    try {
        assert.deepEqual(await manager.playNext(queue.guildId), { status: 'queue_empty' });
        assert.equal(manager.getQueue(queue.guildId), undefined);
        assert.equal(connection.destroyCalls, 1);
    } finally {
        settings.getSettings = originalSettings;
    }
});

test('Stop keeps idle voice recovery enabled without restarting playback', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalJoin = manager.joinChannel;
    const queue = createQueue('guild-stop-keeps-voice', new FakeAudioPlayer(false));
    queue.currentTrack = track('stop-keeps-voice');
    queue.playback = 'playing';
    const replacement = new FakeVoiceConnection();
    let joins = 0;
    manager.joinChannel = async () => {
        joins += 1;
        queue.connection = replacement;
        return replacement;
    };

    try {
        assert.equal(manager.stop(queue.guildId), true);
        assert.equal(queue.isManualDisconnect, false);
        assert.equal(queue.shouldKeepConnection, true);
        assert.equal(await manager.reconnectWithBackoff(queue, 0), true);
        assert.equal(joins, 1);
        assert.equal(queue.currentTrack, null);
        assert.deepEqual(queue.tracks, []);
        assert.match(queue.playback, /^(stopping|idle)$/);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        manager.joinChannel = originalJoin;
    }
});

test('a member returning during the settings read prevents stale empty-channel disconnection', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const queue = createQueue('guild-member-return-race', new FakeAudioPlayer(false));
    const savedSettings = await originalSettings(queue.guildId);
    let members = 0;
    queue.voiceChannel.members.filter = () => ({ size: members });
    let resolveSettings!: (value: unknown) => void;
    settings.getSettings = () => new Promise((resolve) => { resolveSettings = resolve; });

    try {
        const evaluation = manager.evaluateVoiceChannel(queue.guildId);
        members = 1;
        resolveSettings(savedSettings);
        await evaluation;
        assert.equal(manager.getQueue(queue.guildId), queue);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        settings.getSettings = originalSettings;
    }
});

test('an empty-channel evaluation cannot delete a replacement queue', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const queue = createQueue('guild-member-queue-race', new FakeAudioPlayer(false));
    const savedSettings = await originalSettings(queue.guildId);
    queue.voiceChannel.members.filter = () => ({ size: 0 });
    let resolveSettings!: (value: unknown) => void;
    settings.getSettings = () => new Promise((resolve) => { resolveSettings = resolve; });

    try {
        const evaluation = manager.evaluateVoiceChannel(queue.guildId);
        manager.deleteQueue(queue.guildId, true);
        const replacement = createQueue(queue.guildId, new FakeAudioPlayer(false));
        resolveSettings(savedSettings);
        await evaluation;
        assert.equal(manager.getQueue(queue.guildId), replacement);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        settings.getSettings = originalSettings;
    }
});

test('an empty-channel evaluation cannot act on a voice channel changed during the settings read', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const queue = createQueue('guild-member-channel-race', new FakeAudioPlayer(false));
    const savedSettings = await originalSettings(queue.guildId);
    queue.voiceChannel.members.filter = () => ({ size: 0 });
    let resolveSettings!: (value: unknown) => void;
    settings.getSettings = () => new Promise((resolve) => { resolveSettings = resolve; });

    try {
        const evaluation = manager.evaluateVoiceChannel(queue.guildId);
        queue.voiceChannel = { ...queue.voiceChannel, id: 'replacement-channel' };
        resolveSettings(savedSettings);
        await evaluation;
        assert.equal(manager.getQueue(queue.guildId), queue);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        settings.getSettings = originalSettings;
    }
});

test('an empty-queue settings read cannot delete a replacement session', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const queue = createQueue('guild-empty-queue-replacement', new FakeAudioPlayer(false));
    const savedSettings = { ...await originalSettings(queue.guildId), stayConnected: false, stayConnectedAlways: false };
    let resolveSettings!: (value: unknown) => void;
    settings.getSettings = () => new Promise((resolve) => { resolveSettings = resolve; });

    try {
        const empty = manager.playNext(queue.guildId);
        await new Promise((resolve) => setImmediate(resolve));
        manager.deleteQueue(queue.guildId, true);
        const replacement = createQueue(queue.guildId, new FakeAudioPlayer(false));
        resolveSettings(savedSettings);
        await empty;
        assert.equal(manager.getQueue(queue.guildId), replacement);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        settings.getSettings = originalSettings;
    }
});

test('a manual leave during the reconnect settings read prevents any new voice join', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const originalJoin = manager.joinChannel;
    const queue = createQueue('guild-reconnect-leave-settings', new FakeAudioPlayer(false));
    const savedSettings = await originalSettings(queue.guildId);
    let resolveSettings!: (value: unknown) => void;
    let joins = 0;
    settings.getSettings = () => new Promise((resolve) => { resolveSettings = resolve; });
    manager.joinChannel = async () => { joins += 1; return new FakeVoiceConnection(); };

    try {
        const reconnect = manager.reconnectWithBackoff(queue, 0);
        manager.deleteQueue(queue.guildId, true);
        resolveSettings(savedSettings);
        assert.equal(await reconnect, false);
        assert.equal(joins, 0);
        assert.equal(manager.getQueue(queue.guildId), undefined);
    } finally {
        settings.getSettings = originalSettings;
        manager.joinChannel = originalJoin;
    }
});

test('concurrent voice recoveries contain the same unexpected join rejection', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalJoin = manager.joinChannel;
    const queue = createQueue('guild-reconnect-rejection', new FakeAudioPlayer(false));
    let joins = 0;
    manager.joinChannel = async () => {
        joins += 1;
        throw new Error('synthetic voice join failure');
    };

    try {
        assert.deepEqual(await Promise.all([
            manager.reconnectWithBackoff(queue, 0),
            manager.reconnectWithBackoff(queue, 0),
        ]), [false, false]);
        assert.equal(joins, 1);
        assert.equal(queue.isReconnecting, false);
        assert.equal(manager.runtime(queue.guildId).reconnectAttempt, null);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        manager.joinChannel = originalJoin;
    }
});

test('Discord can recover Ready after the former 900ms deadline without destroying its connection', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalJoin = manager.joinChannel;
    const queue = createQueue('guild-discord-delayed-ready', new FakeAudioPlayer(false));
    const connection = new FakeVoiceConnection();
    connection.state = { status: 'disconnected' };
    queue.connection = connection;
    manager.attachConnectionListeners(queue, connection);
    let joins = 0;
    manager.joinChannel = async () => { joins += 1; return null; };
    const readyTimer = setTimeout(() => connection.transition('ready'), 1_050);

    try {
        assert.ok(manager.voiceRecoveryWaitMs >= 5_000);
        const disconnected = connection.listeners('disconnected')[0] as () => Promise<void>;
        await disconnected();
        assert.equal(joins, 0);
        assert.equal(connection.destroyCalls, 0);
        assert.equal(connection.subscribeCalls, 1);
        assert.equal(queue.connection, connection);
        assert.equal(manager.getQueue(queue.guildId), queue);
    } finally {
        clearTimeout(readyTimer);
        manager.deleteQueue(queue.guildId, true);
        manager.joinChannel = originalJoin;
    }
});

test('opt-in saved-queue recovery still takes precedence over automatic reconnect', async () => {
    const manager = modules.queueModule.queueManager as any;
    const settings = modules.guildSettingsManager as any;
    const originalSettings = settings.getSettings;
    const originalJoin = manager.joinChannel;
    const queue = createQueue('guild-saved-queue-recovery', new FakeAudioPlayer(false));
    queue.currentTrack = track('saved-queue-recovery');
    let joins = 0;
    settings.getSettings = async (guildId: string) => ({ ...await originalSettings(guildId), queueRecoveryEnabled: true });
    manager.joinChannel = async () => { joins += 1; return new FakeVoiceConnection(); };

    try {
        assert.equal(await manager.reconnectWithBackoff(queue, 0), false);
        assert.equal(joins, 0);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        settings.getSettings = originalSettings;
        manager.joinChannel = originalJoin;
    }
});

test('an immediate natural stream end reports one failure and advances without retrying the track', async () => {
    const manager = modules.queueModule.queueManager as any;
    const originalPlayNext = manager.playNext;
    const queue = createQueue('guild-early-stream-end', new FakeAudioPlayer(false));
    queue.player = null;
    manager.ensurePlayer(queue);
    const selectedTrack = track('early-stream-end');
    const endedResource = { ...resource(selectedTrack.id), playbackDuration: 120 };
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    manager.runtime(queue.guildId).activeResource = endedResource;
    const failures: string[] = [];
    const listener = (_queue: unknown, failedTrack: Track, code: string) => {
        if (failedTrack === selectedTrack) failures.push(code);
    };
    manager.on('trackFailed', listener);
    let nextCalls = 0;
    manager.playNext = async () => { nextCalls += 1; return { status: 'queue_empty' }; };

    try {
        queue.player.emit('idle', { status: 'playing', resource: endedResource });
        queue.player.emit('idle', { status: 'playing', resource: endedResource });
        assert.deepEqual(failures, ['stream_ended_early']);
        assert.equal(nextCalls, 1, 'la piste interrompue ne doit pas être relancée en boucle');
        assert.equal(queue.currentTrack, null);
        assert.equal(manager.runtime(queue.guildId).activeResource, null);
    } finally {
        manager.off('trackFailed', listener);
        manager.deleteQueue(queue.guildId, true);
        manager.playNext = originalPlayNext;
    }
});

for (const scenario of [
    { name: 'ordinary playback', duration: 180, startSeconds: 0, playedMs: 3_000 },
    { name: 'seek close to the end', duration: 180, startSeconds: 179, playedMs: 120 },
    { name: 'a genuinely short track', duration: 5, startSeconds: 0, playedMs: 120 },
    { name: 'an unknown live duration', duration: 0, startSeconds: 0, playedMs: 120 },
    { name: 'missing playback position metadata', duration: 180, startSeconds: undefined, playedMs: 120 },
]) {
    test(`natural end is not misclassified for ${scenario.name}`, () => {
        const manager = modules.queueModule.queueManager as any;
        const originalPlayNext = manager.playNext;
        const queue = createQueue(`guild-end-${scenario.name}`, new FakeAudioPlayer(false));
        queue.player = null;
        manager.ensurePlayer(queue);
        const selectedTrack = { ...track(scenario.name), duration: scenario.duration };
        const endedResource = {
            ...resource(selectedTrack.id),
            metadata: { trackId: selectedTrack.id, createdAt: Date.now(), startSeconds: scenario.startSeconds },
            playbackDuration: scenario.playedMs,
        };
        queue.currentTrack = selectedTrack;
        queue.playback = 'playing';
        manager.runtime(queue.guildId).activeResource = endedResource;
        const failures: string[] = [];
        const listener = (_queue: unknown, failedTrack: Track, code: string) => {
            if (failedTrack === selectedTrack) failures.push(code);
        };
        manager.on('trackFailed', listener);
        manager.playNext = async () => ({ status: 'queue_empty' });

        try {
            queue.player.emit('idle', { status: 'playing', resource: endedResource });
            assert.deepEqual(failures, []);
            assert.equal(queue.currentTrack, null);
        } finally {
            manager.off('trackFailed', listener);
            manager.deleteQueue(queue.guildId, true);
            manager.playNext = originalPlayNext;
        }
    });
}

for (const action of ['stop', 'skip'] as const) {
    test(`${action} cannot report an early-stream failure from the retired resource`, () => {
        const manager = modules.queueModule.queueManager as any;
        const originalPlayNext = manager.playNext;
        const queue = createQueue(`guild-manual-${action}-early`, new FakeAudioPlayer(false));
        queue.player = null;
        manager.ensurePlayer(queue);
        const selectedTrack = track(`manual-${action}-early`);
        const endedResource = { ...resource(selectedTrack.id), playbackDuration: 120 };
        queue.currentTrack = selectedTrack;
        queue.playback = 'playing';
        manager.runtime(queue.guildId).activeResource = endedResource;
        const failures: string[] = [];
        const listener = (_queue: unknown, failedTrack: Track, code: string) => {
            if (failedTrack === selectedTrack) failures.push(code);
        };
        manager.on('trackFailed', listener);
        manager.playNext = async () => ({ status: 'queue_empty' });

        try {
            assert.equal(manager[action](queue.guildId), true);
            queue.player.emit('idle', { status: 'playing', resource: endedResource });
            assert.deepEqual(failures, []);
            assert.equal(queue.currentTrack, null);
        } finally {
            manager.off('trackFailed', listener);
            manager.deleteQueue(queue.guildId, true);
            manager.playNext = originalPlayNext;
        }
    });
}

test('an old resource ending immediately cannot fail the replacement track', () => {
    const manager = modules.queueModule.queueManager as any;
    const queue = createQueue('guild-early-retired-resource', new FakeAudioPlayer(false));
    queue.player = null;
    manager.ensurePlayer(queue);
    const selectedTrack = track('replacement-after-early');
    const retired = { ...resource('old-track', 100), playbackDuration: 120 };
    const replacement = resource(selectedTrack.id, 200);
    manager.runtime(queue.guildId).activeResource = retired;
    manager.teardownActiveResource(queue.guildId);
    manager.runtime(queue.guildId).activeResource = replacement;
    queue.currentTrack = selectedTrack;
    queue.playback = 'playing';
    const failures: string[] = [];
    const listener = (_queue: unknown, failedTrack: Track, code: string) => {
        if (failedTrack === selectedTrack) failures.push(code);
    };
    manager.on('trackFailed', listener);

    try {
        queue.player.emit('idle', { status: 'playing', resource: retired });
        assert.deepEqual(failures, []);
        assert.equal(queue.currentTrack, selectedTrack);
        assert.equal(manager.runtime(queue.guildId).activeResource, replacement);
    } finally {
        manager.off('trackFailed', listener);
        manager.deleteQueue(queue.guildId, true);
    }
});

test('two confirmed plays of the same track can both end within the debounce window', () => {
    const manager = modules.queueModule.queueManager as any;
    const originalPlayNext = manager.playNext;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-consecutive-same-track-end', player);
    queue.player = null;
    manager.ensurePlayer(queue);
    const onIdle = queue.player.listeners('idle')[0] as (state: unknown) => void;
    queue.player = player;
    const firstTrack = track('same-track-early-end');
    const secondTrack = track(firstTrack.id);
    const firstResource = { ...resource(firstTrack.id, 100), playbackDuration: 120 };
    const secondResource = { ...resource(secondTrack.id, 200), playbackDuration: 120 };
    const failures: Track[] = [];
    const listener = (failedQueue: unknown, failedTrack: Track) => {
        if (failedQueue === queue) failures.push(failedTrack);
    };
    manager.on('trackFailed', listener);
    let nextCalls = 0;
    manager.playNext = async () => { nextCalls += 1; return { status: 'queue_empty' }; };

    try {
        queue.currentTrack = firstTrack;
        queue.playback = 'playing';
        manager.runtime(queue.guildId).activeResource = firstResource;
        onIdle({ status: 'playing', resource: firstResource });
        assert.deepEqual(failures, [firstTrack]);

        queue.tracks.push(secondTrack);
        manager.runtime(queue.guildId).activeResource = secondResource;
        manager.runtime(queue.guildId).pendingStart = { queue, track: secondTrack, resource: secondResource };
        player.state = { status: 'playing', resource: secondResource };
        assert.equal(manager.promotePendingStart(queue, secondResource), true);
        queue.playback = 'playing';

        onIdle({ status: 'playing', resource: firstResource });
        assert.equal(queue.currentTrack, secondTrack, 'un ancien Idle reste ignoré après la nouvelle confirmation');
        onIdle({ status: 'playing', resource: secondResource });
        onIdle({ status: 'playing', resource: secondResource });

        assert.deepEqual(failures, [firstTrack, secondTrack]);
        assert.equal(queue.currentTrack, null, 'le second Idle ne doit pas laisser la file bloquée');
        assert.equal(nextCalls, 2, 'une seule progression par lecture confirmée');
    } finally {
        manager.off('trackFailed', listener);
        manager.deleteQueue(queue.guildId, true);
        manager.playNext = originalPlayNext;
    }
});

async function waitFor(condition: () => boolean, message: string, timeoutMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(condition(), true, message);
}

test('a second /play during a start cannot launch a competing start', async () => {
    const { canBeginPlayback } = await import('../src/services/GuildPlayback.js');
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-double-play', player);
    const firstTrack = track('double-first');
    const secondTrack = track('double-second');
    const firstResource = resource(firstTrack.id, 50);
    queue.tracks.push(firstTrack);
    let resolveResource: ((value: unknown) => void) | undefined;
    wrapper.createResource = () => new Promise((resolve) => { resolveResource = resolve; });

    try {
        assert.equal(canBeginPlayback(queue), true);
        const start = manager.playNext(queue.guildId);
        await waitFor(() => resolveResource !== undefined, 'la résolution audio doit avoir commencé');
        assert.equal(queue.playback, 'starting');

        queue.tracks.push(secondTrack);
        assert.equal(canBeginPlayback(queue), false, 'le second /play ne doit pas relancer playNext');

        resolveResource!(firstResource);
        await waitFor(
            () => manager.runtime(queue.guildId).activeResource === firstResource,
            'la ressource doit être remise au player'
        );
        player.transition('playing', firstResource);

        assert.deepEqual(await start, { status: 'started', track: firstTrack });
        assert.equal(queue.playback, 'playing');
        assert.equal(queue.currentTrack, firstTrack);
        assert.deepEqual(queue.tracks, [secondTrack]);
        assert.equal(canBeginPlayback(queue), false);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
    }
});

test('skip during source resolution drops the loading track and starts the next one', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-skip-while-loading', player);
    const loadingTrack = track('skip-loading');
    const nextTrack = track('skip-next');
    queue.tracks.push(loadingTrack, nextTrack);
    let resolveLoading: ((value: unknown) => void) | undefined;
    wrapper.createResource = (_guildId: string, selected: Track) => selected.id === loadingTrack.id
        ? new Promise((resolve) => { resolveLoading = resolve; })
        : Promise.resolve(resource(selected.id, 61));

    try {
        const start = manager.playNext(queue.guildId);
        await waitFor(() => resolveLoading !== undefined, 'la résolution audio doit avoir commencé');
        assert.equal(queue.playback, 'starting');

        assert.equal(manager.skip(queue.guildId), true);
        resolveLoading!(resource(loadingTrack.id, 60));
        assert.equal((await start).code, 'cancelled');

        await waitFor(() => queue.currentTrack === nextTrack, 'la piste suivante doit démarrer après le skip');
        assert.equal(queue.playback, 'playing');
        assert.deepEqual(queue.tracks, []);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
    }
});

test('a start that throws leaves the guild idle instead of stuck in starting', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-start-throws', player);
    const selectedTrack = track('start-throws');
    queue.tracks.push(selectedTrack);
    wrapper.createResource = async () => resource(selectedTrack.id, 70) as never;
    player.play = () => { throw new Error('resource already ended'); };

    try {
        await assert.rejects(manager.playNext(queue.guildId), /resource already ended/);
        assert.equal(queue.playback, 'idle');
        assert.equal(manager.runtime(queue.guildId).activeResource, null);
        assert.equal(manager.runtime(queue.guildId).pendingStart, null);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
    }
});

test('pause and resume move between playing and paused and track the pause reason', () => {
    const manager = modules.queueModule.queueManager as any;
    const player = new FakeAudioPlayer(false);
    const queue = createQueue('guild-pause-resume', player);
    queue.currentTrack = track('pause-resume');
    queue.playback = 'playing';
    queue.startedAt = Date.now() - 5_000;

    try {
        assert.equal(manager.pause(queue.guildId), true);
        assert.equal(queue.playback, 'paused');
        assert.equal(queue.pauseReason, 'user');
        assert.equal(manager.pause(queue.guildId), false, 'déjà en pause');

        assert.equal(manager.resume(queue.guildId), true);
        assert.equal(queue.playback, 'playing');
        assert.equal(queue.pauseReason, null);
        assert.equal(manager.resume(queue.guildId), false, 'pas en pause');
    } finally {
        manager.deleteQueue(queue.guildId, true);
    }
});

test('a direct link prewarms its stream unless an upcoming track already owns the warmup', () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalWarmTrack = wrapper.warmTrack;
    const warmed: Array<{ guildId: string; id: string; url: string }> = [];
    wrapper.warmTrack = async (guildId: string, source: { id: string; url: string }) => {
        warmed.push({ guildId, id: source.id, url: source.url });
    };
    const source = { id: 'prewarm-id', url: 'https://www.youtube.com/watch?v=prewarm-id' };

    try {
        manager.prewarmSource('guild-prewarm-no-queue', source);
        assert.deepEqual(warmed, [{ guildId: 'guild-prewarm-no-queue', ...source }]);

        const queue = createQueue('guild-prewarm-busy', new FakeAudioPlayer(false));
        manager.prewarmSource(queue.guildId, source);
        assert.equal(warmed.length, 2, 'une file sans piste à venir peut préchauffer');

        queue.tracks.push(track('prewarm-upcoming'));
        manager.prewarmSource(queue.guildId, source);
        assert.equal(warmed.length, 2, 'la piste suivante garde le préchauffage de la guilde');
        manager.deleteQueue(queue.guildId, true);
    } finally {
        wrapper.warmTrack = originalWarmTrack;
    }
});

function installCrossfadeDoubles(seconds: number) {
    const wrapper = modules.audioWrapper as any;
    const settings = modules.guildSettingsManager as any;
    const originals = {
        watch: wrapper.watchCrossfadeWindow,
        open: wrapper.isCrossfadeWindowOpen,
        into: wrapper.crossfadeInto,
        cancel: wrapper.cancelCrossfade,
        getSettings: settings.getSettings,
    };
    const state = {
        onWindow: undefined as (() => void) | undefined,
        windowOpen: false,
        cancels: 0,
        prepared: [] as Array<{ track: Track; fadeSeconds: number; accept: () => boolean }>,
        restore: () => {
            wrapper.watchCrossfadeWindow = originals.watch;
            wrapper.isCrossfadeWindowOpen = originals.open;
            wrapper.crossfadeInto = originals.into;
            wrapper.cancelCrossfade = originals.cancel;
            settings.getSettings = originals.getSettings;
        },
    };
    wrapper.watchCrossfadeWindow = (_resource: unknown, onWindow: () => void) => {
        state.onWindow = onWindow;
        return true;
    };
    wrapper.isCrossfadeWindowOpen = () => state.windowOpen;
    wrapper.cancelCrossfade = () => { state.cancels += 1; };
    wrapper.crossfadeInto = async (
        _guildId: string, _resource: unknown, nextTrack: Track, _sponsor: boolean, fadeSeconds: number, accept: () => boolean
    ) => {
        state.prepared.push({ track: nextTrack, fadeSeconds, accept });
        return true;
    };
    settings.getSettings = async (guildId: string) => ({
        ...(await originals.getSettings(guildId)),
        crossfadeSeconds: seconds,
    });
    return state;
}

test('a crossfade handover promotes the next track without stopping the player', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const crossfade = installCrossfadeDoubles(6);
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-crossfade-handover', player);
    const firstTrack = track('fade-first');
    const secondTrack = track('fade-second');
    const firstResource = resource(firstTrack.id, 80);
    queue.tracks.push(firstTrack, secondTrack);
    const requestedFades: number[] = [];
    wrapper.createResource = async (...args: unknown[]) => {
        requestedFades.push(args[5] as number);
        return firstResource as never;
    };
    const events: string[] = [];
    const onEnd = (_queue: unknown, ended: Track) => events.push(`end:${ended.id}`);
    const onStart = (started: { currentTrack: Track }) => events.push(`start:${started.currentTrack.id}`);

    try {
        assert.equal((await manager.playNext(queue.guildId)).status, 'started');
        assert.deepEqual(requestedFades, [6], 'la ressource est créée en mode fondu');
        manager.on('trackEnd', onEnd);
        manager.on('trackStart', onStart);

        crossfade.windowOpen = true;
        crossfade.onWindow!();
        await waitFor(() => crossfade.prepared.length === 1, 'la piste suivante doit être préparée');
        assert.equal(crossfade.prepared[0]!.track, secondTrack);
        assert.equal(crossfade.prepared[0]!.fadeSeconds, 6);
        assert.equal(queue.currentTrack, firstTrack, 'rien ne change avant le début du fondu');

        crossfade.windowOpen = false;
        assert.equal(crossfade.prepared[0]!.accept(), true);
        assert.equal(queue.currentTrack, secondTrack);
        assert.deepEqual(queue.tracks, []);
        assert.equal(queue.playback, 'playing');
        assert.deepEqual(events, ['end:fade-first', 'start:fade-second']);
        assert.equal(player.state.status, 'playing', 'le lecteur ne passe jamais par idle');
        assert.equal(manager.runtime(queue.guildId).activeResource, firstResource);
        assert.equal(manager.getCurrentTime(queue.guildId), 0, 'la position repart de zéro');
        assert.equal(crossfade.prepared[0]!.accept(), false, 'un fondu ne se déclenche qu’une fois');
    } finally {
        manager.off('trackEnd', onEnd);
        manager.off('trackStart', onStart);
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
        crossfade.restore();
    }
});

test('a prepared crossfade follows the queue: removing the next track cancels it and prepares the new one', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const crossfade = installCrossfadeDoubles(4);
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-crossfade-queue-edit', player);
    const firstTrack = track('edit-first');
    const removedTrack = track('edit-removed');
    const thirdTrack = track('edit-third');
    queue.tracks.push(firstTrack, removedTrack, thirdTrack);
    wrapper.createResource = async () => resource(firstTrack.id, 81) as never;

    try {
        assert.equal((await manager.playNext(queue.guildId)).status, 'started');
        crossfade.windowOpen = true;
        crossfade.onWindow!();
        await waitFor(() => crossfade.prepared.length === 1, 'le fondu vers la piste suivante doit être préparé');

        assert.equal(manager.removeTrackAt(queue.guildId, 0), removedTrack);
        assert.equal(crossfade.cancels, 1, 'le fondu vers la piste retirée est annulé');
        await waitFor(() => crossfade.prepared.length === 2, 'le fondu vers la nouvelle piste suivante doit être préparé');
        assert.equal(crossfade.prepared[1]!.track, thirdTrack);

        assert.equal(crossfade.prepared[0]!.accept(), false, 'la piste retirée ne peut plus démarrer');
        assert.equal(queue.currentTrack, firstTrack);
        assert.equal(crossfade.prepared[1]!.accept(), true);
        assert.equal(queue.currentTrack, thirdTrack);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
        crossfade.restore();
    }
});

test('crossfade stays off when the setting is zero', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const crossfade = installCrossfadeDoubles(0);
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-crossfade-off', player);
    queue.tracks.push(track('off-first'), track('off-second'));
    wrapper.createResource = async () => resource('off-first', 82) as never;

    try {
        assert.equal((await manager.playNext(queue.guildId)).status, 'started');
        crossfade.windowOpen = true;
        crossfade.onWindow!();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(crossfade.prepared.length, 0);
        assert.equal(manager.runtime(queue.guildId).crossfadeNext, null);
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
        crossfade.restore();
    }
});

test('a crossfaded track whose stream dies early is resumed once instead of being skipped', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const crossfade = installCrossfadeDoubles(5);
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-crossfade-recovery', player);
    const firstTrack = track('recover-first');
    const fadedTrack = track('recover-faded');
    const afterTrack = track('recover-after');
    const mixerResource = resource(firstTrack.id, 90);
    const resumedResource = resource(fadedTrack.id, 91);
    queue.tracks.push(firstTrack, fadedTrack, afterTrack);
    const requests: Array<{ id: string; offset: number }> = [];
    wrapper.createResource = async (_guildId: string, requested: Track, offset: number) => {
        requests.push({ id: requested.id, offset });
        return (requested.id === firstTrack.id ? mixerResource : resumedResource) as never;
    };

    try {
        assert.equal((await manager.playNext(queue.guildId)).status, 'started');
        crossfade.windowOpen = true;
        crossfade.onWindow!();
        await waitFor(() => crossfade.prepared.length === 1, 'le fondu doit être préparé');
        crossfade.windowOpen = false;
        assert.equal(crossfade.prepared[0]!.accept(), true);
        queue.startedAt = Date.now() - 7_000; // 7 s de la nouvelle piste ont été jouées

        // La source lâche : le lecteur signale la fin du flux alors qu'il reste 173 s.
        manager.handleTrackEnd(queue, mixerResource);

        await waitFor(() => requests.length === 2, 'la piste doit être relancée');
        assert.equal(requests[1]!.id, fadedTrack.id);
        assert.ok(requests[1]!.offset >= 6 && requests[1]!.offset <= 8, `reprise à ${requests[1]!.offset}s`);
        await waitFor(() => manager.runtime(queue.guildId).activeResource === resumedResource, 'la reprise doit être installée');
        assert.equal(queue.currentTrack, fadedTrack, 'la piste n’est pas sautée');
        assert.deepEqual(queue.tracks, [afterTrack]);

        // Une seconde fin de flux est une vraie fin : pas de boucle de reprise.
        await waitFor(() => player.state.status === 'playing', 'la reprise doit jouer');
        manager.runtime(queue.guildId).lastTrackEnd = null;
        wrapper.createResource = async (_guildId: string, requested: Track) => resource(requested.id, 92) as never;
        manager.handleTrackEnd(queue, resumedResource);
        await waitFor(() => queue.currentTrack === afterTrack, 'la fin suivante passe à la piste d’après');
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
        crossfade.restore();
    }
});

test('skipping a crossfaded track really skips it', async () => {
    const manager = modules.queueModule.queueManager as any;
    const wrapper = modules.audioWrapper as any;
    const originalCreateResource = wrapper.createResource;
    const crossfade = installCrossfadeDoubles(5);
    const player = new FakeAudioPlayer(true);
    const queue = createQueue('guild-crossfade-skip', player);
    const firstTrack = track('skipfade-first');
    const fadedTrack = track('skipfade-faded');
    const afterTrack = track('skipfade-after');
    queue.tracks.push(firstTrack, fadedTrack, afterTrack);
    wrapper.createResource = async (_guildId: string, requested: Track) => resource(requested.id, Date.now()) as never;

    try {
        assert.equal((await manager.playNext(queue.guildId)).status, 'started');
        crossfade.windowOpen = true;
        crossfade.onWindow!();
        await waitFor(() => crossfade.prepared.length === 1, 'le fondu doit être préparé');
        crossfade.windowOpen = false;
        assert.equal(crossfade.prepared[0]!.accept(), true);

        assert.equal(manager.skip(queue.guildId), true);
        await waitFor(() => queue.currentTrack === afterTrack, 'le skip passe à la piste suivante');
    } finally {
        manager.deleteQueue(queue.guildId, true);
        wrapper.createResource = originalCreateResource;
        crossfade.restore();
    }
});
