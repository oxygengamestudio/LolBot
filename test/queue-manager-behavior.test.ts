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
    for (const timer of manager.bufferingWatchdogs.values()) clearTimeout(timer);
    for (const timer of manager.retiredResources.values()) clearTimeout(timer);
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
    assert.equal(manager.activeResources.get(queue.guildId), selectedResource);
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
    queue.isPlaying = true;

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
        assert.notEqual(manager.activeResources.get(queue.guildId), staleSeekResource);
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
    queue.isPlaying = true;
    wrapper.createResource = async () => selectedResource as never;

    try {
        assert.equal(await manager.seekTo(queue.guildId, 30), true);
        assert.equal(queue.currentTrack, selectedTrack);
        assert.equal(manager.activeResources.get(queue.guildId), selectedResource);
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
    queue.isPlaying = true;
    manager.playbackStartTimeoutMs = 20;
    wrapper.createResource = async () => selectedResource as never;
    wrapper.teardownResource = (value: unknown) => { tornDown.push(value); };

    try {
        assert.equal(await manager.seekTo(queue.guildId, 30), false);
        assert.ok(tornDown.includes(selectedResource));
        assert.notEqual(manager.activeResources.get(queue.guildId), selectedResource);
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
    queue.isPlaying = true;
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
        assert.equal(queue.isPlaying, false);
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
        manager.activeResources.get(queueA.guildId),
        manager.activeResources.get(queueB.guildId)
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
            assert.equal(manager.activeResources.get(fixture.queue.guildId), fixture.selectedResource);
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
    queue.isPlaying = true;
    queue.startedAt = Date.now() - 1000;
    queue.tracks.push(nextTrack);
    manager.activeResources.set(queue.guildId, previousResource);
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

    manager.activeResources.set(guildId, retired);
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
    manager.activeResources.set(queue.guildId, selectedResource);
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
    queue.isPlaying = true;
    queue.startedAt = Date.now() - 4_000;
    player.state = { status: 'buffering', resource: selectedResource };
    manager.activeResources.set(queue.guildId, selectedResource);

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
        assert.notEqual(manager.activeResources.get(queue.guildId), staleRecoveryResource);
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
    queue.isPlaying = true;
    queue.startedAt = Date.now() - 8_000;
    manager.activeResources.delete(queue.guildId);

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
        assert.notEqual(manager.activeResources.get(queue.guildId), staleRecoveryResource);
        assert.equal(queue.currentTrack, null);
    } finally {
        manager.joinChannel = originalJoinChannel;
        wrapper.createResource = originalCreateResource;
        wrapper.teardownResource = originalTeardownResource;
    }
});
