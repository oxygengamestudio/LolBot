import assert from 'node:assert/strict';
import { before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';

type MutableYouTubeService = Record<string, any> & {
    getVideoInfo: (videoId: string, context?: { scopeKey?: string; signal?: AbortSignal }) => Promise<any>;
    getPlaylistTracks: (
        playlistId: string,
        requestedBy: string,
        requestedById: string,
        context?: { scopeKey?: string; signal?: AbortSignal }
    ) => Promise<any>;
    createTrackFromUrl: (
        url: string,
        requestedBy: string,
        requestedById: string,
        context?: { scopeKey?: string; signal?: AbortSignal }
    ) => Promise<any>;
};

let YouTubeService: new () => MutableYouTubeService;

before(async () => {
    ({ YouTubeService } = await import('../src/services/YouTubeService.js') as any);
});

function videoInfo(id: string): Record<string, unknown> {
    return {
        id,
        title: `Video ${id}`,
        duration: 180,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        channelTitle: 'Channel',
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Condition not reached before timeout');
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('metadata cache misses share the global limit and keep one active operation per guild', async () => {
    const service = new YouTubeService();
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
        releaseFetches = resolve;
    });
    let activeTotal = 0;
    let maxActiveTotal = 0;
    const activeByScope = new Map<string, number>();
    const maxActiveByScope = new Map<string, number>();

    service.fetchVideoInfo = async (id: string) => {
        const scope = id.split('-')[0] ?? 'unknown';
        activeTotal += 1;
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
        const scopedActive = (activeByScope.get(scope) ?? 0) + 1;
        activeByScope.set(scope, scopedActive);
        maxActiveByScope.set(scope, Math.max(maxActiveByScope.get(scope) ?? 0, scopedActive));
        await fetchGate;
        activeTotal -= 1;
        activeByScope.set(scope, scopedActive - 1);
        return videoInfo(id);
    };

    const requests = [
        service.getVideoInfo('a-one', { scopeKey: 'a' }),
        service.getVideoInfo('a-two', { scopeKey: 'a' }),
        service.getVideoInfo('b-one', { scopeKey: 'b' }),
        service.getVideoInfo('c-one', { scopeKey: 'c' }),
        service.getVideoInfo('d-one', { scopeKey: 'd' }),
        service.getVideoInfo('e-one', { scopeKey: 'e' }),
    ];

    await waitFor(() => activeTotal === 4);
    assert.equal(maxActiveTotal, 4, 'la concurrence provider globale doit rester bornée à quatre');
    assert.equal(maxActiveByScope.get('a'), 1, 'une guilde ne doit avoir qu’une résolution active');

    releaseFetches();
    await Promise.all(requests);
    assert.equal(maxActiveTotal, 4);
    assert.equal(maxActiveByScope.get('a'), 1);
});

test('a queued metadata resolution is cancelled before it reaches the provider', async () => {
    const service = new YouTubeService();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    let fetchCount = 0;
    service.fetchVideoInfo = async (id: string) => {
        fetchCount += 1;
        if (id === 'first') {
            await firstGate;
        }
        return videoInfo(id);
    };

    const first = service.getVideoInfo('first', { scopeKey: 'guild' });
    await waitFor(() => fetchCount === 1);
    const controller = new AbortController();
    const queued = service.getVideoInfo('second', { scopeKey: 'guild', signal: controller.signal });
    controller.abort();

    await assert.rejects(queued, (error: any) => error?.name === 'AbortError');
    assert.equal(fetchCount, 1, 'une opération annulée en file ne doit pas appeler le provider');
    releaseFirst();
    await first;
});

test('playlist cache misses use the same scoped admission and remain single-flight', async () => {
    const service = new YouTubeService();
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let fetchCount = 0;
    service.fetchPlaylistTracks = async (id: string) => {
        fetchCount += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await fetchGate;
        active -= 1;
        return { id, title: id, itemCount: 0, tracks: [] };
    };

    const first = service.getPlaylistTracks('same-playlist', 'A', '1', { scopeKey: 'guild' });
    const duplicate = service.getPlaylistTracks('same-playlist', 'B', '2', { scopeKey: 'guild' });
    const next = service.getPlaylistTracks('next-playlist', 'A', '1', { scopeKey: 'guild' });

    await waitFor(() => active === 1);
    assert.equal(fetchCount, 1, 'la même playlist doit partager une résolution en vol');
    assert.equal(maxActive, 1);
    releaseFetch();

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate, next]);
    assert.equal(fetchCount, 2);
    assert.equal(maxActive, 1, 'une guilde ne doit pas résoudre deux playlists simultanément');
    assert.equal(firstResult?.id, duplicateResult?.id);
});

test('createTrackFromUrl delegates admission once and propagates the abort signal without nested deadlock', async () => {
    const service = new YouTubeService();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    service.fetchVideoInfo = async (id: string, signal?: AbortSignal) => {
        observedSignal = signal;
        return videoInfo(id);
    };

    const track = await Promise.race([
        service.createTrackFromUrl(
            'https://www.youtube.com/watch?v=abcdefghijk',
            'Requester',
            '123',
            { scopeKey: 'guild', signal: controller.signal }
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nested admission deadlock')), 250)),
    ]);

    assert.equal(track?.sourceId, 'abcdefghijk');
    assert.equal(observedSignal, controller.signal);
});

test('video and playlist metadata caches are LRU-bounded and eagerly remove expired entries', async () => {
    const service = new YouTubeService();
    service.metadataCacheMaxEntries = 3;
    service.fetchVideoInfo = async (id: string) => videoInfo(id);
    service.fetchPlaylistTracks = async (id: string) => ({
        id,
        title: `Playlist ${id}`,
        itemCount: 0,
        tracks: [],
    });

    await service.getVideoInfo('video-1');
    await service.getVideoInfo('video-2');
    await service.getVideoInfo('video-3');
    await service.getVideoInfo('video-1'); // Refresh video-1 in the LRU.
    await service.getVideoInfo('video-4');

    assert.equal(service.videoInfoCache.size, 3);
    assert.equal(service.videoInfoCache.has('video-2'), false);
    assert.equal(service.videoInfoCache.has('video-1'), true);

    await service.getPlaylistTracks('playlist-1', 'A', '1');
    await service.getPlaylistTracks('playlist-2', 'A', '1');
    await service.getPlaylistTracks('playlist-3', 'A', '1');
    await service.getPlaylistTracks('playlist-4', 'A', '1');

    assert.equal(service.playlistCache.size, 3);
    assert.equal(service.playlistCache.has('playlist-1'), false);

    service.videoInfoCache.get('video-1').expiresAt = Date.now() - 1;
    service.playlistCache.get('playlist-2').expiresAt = Date.now() - 1;
    await service.getVideoInfo('video-5');
    await service.getPlaylistTracks('playlist-5', 'A', '1');

    assert.equal(service.videoInfoCache.has('video-1'), false);
    assert.equal(service.playlistCache.has('playlist-2'), false);
});

test('negative metadata results use the short TTL and are fetched again after expiry', async () => {
    const service = new YouTubeService();
    let fetchCount = 0;
    service.fetchVideoInfo = async () => {
        fetchCount += 1;
        return null;
    };

    const before = Date.now();
    assert.equal(await service.getVideoInfo('missing'), null);
    assert.equal(await service.getVideoInfo('missing'), null);
    assert.equal(fetchCount, 1);

    const cached = service.videoInfoCache.get('missing');
    assert.ok(cached);
    assert.ok(cached.expiresAt >= before + 29_000);
    assert.ok(cached.expiresAt <= Date.now() + 30_000);

    cached.expiresAt = Date.now() - 1;
    assert.equal(await service.getVideoInfo('missing'), null);
    assert.equal(fetchCount, 2, 'un résultat négatif expiré doit être résolu à nouveau');
});
