import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDataDir = join(tmpdir(), `lolbot-soundcloud-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;

let SoundCloudService: typeof import('../src/services/SoundCloudService.js').SoundCloudService;
let classifyPlayInput: typeof import('../src/commands/play.js').classifyPlayInput;
let playCommand: typeof import('../src/commands/play.js');
let mediaCacheManager: any;
let youtubeService: any;
let soundCloudService: any;
let guildSettingsManager: any;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '2011421339',
        extractor: 'soundcloud',
        extractor_key: 'Soundcloud',
        title: 'Audio Dealer',
        duration: 213.469,
        thumbnail: 'https://i1.sndcdn.com/artworks-test-original.jpg',
        uploader: '$KORCH',
        uploader_id: '150292288',
        webpage_url: 'https://soundcloud.com/skorxh/audio-dealer?si=tracking',
        acodec: 'aac',
        ext: 'm4a',
        ...overrides,
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(predicate(), true, 'condition asynchrone non atteinte avant le délai du test');
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    ({ SoundCloudService } = await import('../src/services/SoundCloudService.js'));
    playCommand = await import('../src/commands/play.js');
    ({ classifyPlayInput } = playCommand);
    ({ mediaCacheManager } = await import('../src/audio/MediaCacheManager.js'));
    ({ youtubeService } = await import('../src/services/YouTubeService.js'));
    ({ soundCloudService } = await import('../src/services/SoundCloudService.js'));
    ({ guildSettingsManager } = await import('../src/services/GuildSettingsManager.js'));
    const { config } = await import('../src/config.js');
    config.audio.ephemeralInfoDeleteDelay = 1;
    await mediaCacheManager.ready;
});

after(async () => {
    await mediaCacheManager.ready;
    await mediaCacheManager.manifestWrite;
    await rm(testDataDir, { recursive: true, force: true });
});

test('SoundCloud URL classification accepts only public track and short-link shapes', () => {
    const service = new SoundCloudService({ runJson: async () => payload() } as any);
    const accepted = [
        'https://soundcloud.com/skorxh/audio-dealer',
        'https://www.soundcloud.com/skorxh/audio-dealer?si=share',
        'https://m.soundcloud.com/skorxh/audio-dealer',
        'https://on.soundcloud.com/AbC_123-x',
    ];
    for (const url of accepted) {
        assert.equal(service.matchesUrl(url), true, url);
    }

    const unsupported = [
        'http://soundcloud.com/skorxh/audio-dealer',
        'https://soundcloud.com/skorxh',
        'https://soundcloud.com/skorxh/sets/my-set',
        'https://soundcloud.com/skorxh/likes',
        'https://soundcloud.com/skorxh/audio-dealer/s-private',
        'https://soundcloud.com/skorxh/audio-dealer?secret_token=s-private',
        'https://soundcloud.com:8443/skorxh/audio-dealer',
        'https://soundcloud.com/sets/not-a-track',
    ];
    for (const url of unsupported) {
        assert.equal(service.classifyUrl(url), 'unsupported', url);
    }

    assert.equal(service.classifyUrl('https://soundcloud.example/skorxh/audio-dealer'), 'not-soundcloud');
    assert.equal(service.classifyUrl('https://evil-soundcloud.com/skorxh/audio-dealer'), 'not-soundcloud');
});

test('play input classification keeps text search but rejects unsupported URLs', () => {
    assert.equal(classifyPlayInput('daft punk harder better faster stronger'), 'search');
    assert.equal(classifyPlayInput('https://www.youtube.com/watch?v=abcdefghijk'), 'youtube');
    assert.equal(classifyPlayInput('https://soundcloud.com/skorxh/audio-dealer'), 'soundcloud');
    assert.equal(classifyPlayInput('https://on.soundcloud.com/AbC123'), 'soundcloud');
    assert.equal(classifyPlayInput('https://soundcloud.com/skorxh/sets/my-set'), 'unsupported-soundcloud');
    assert.equal(classifyPlayInput('https://open.spotify.com/track/example'), 'unsupported-url');
    assert.equal(classifyPlayInput('open.spotify.com/track/example'), 'unsupported-url');
    assert.equal(classifyPlayInput('www.deezer.com/track/example'), 'unsupported-url');
    assert.equal(classifyPlayInput('ftp://example.com/audio'), 'unsupported-url');
    assert.equal(classifyPlayInput('AC/DC thunderstruck'), 'search');
});

test('/play routes SoundCloud directly, rejects third-party URLs, and searches YouTube only for text', async () => {
    const guildId = 'guild-soundcloud-routing';
    const originalSearch = youtubeService.searchWithRanking;
    const originalSoundCloudCreate = soundCloudService.createTrackFromUrl;
    const originalGetSettings = guildSettingsManager.getSettings;
    let searchCalls = 0;
    let soundCloudCalls = 0;
    youtubeService.searchWithRanking = async () => {
        searchCalls += 1;
        return [];
    };
    soundCloudService.createTrackFromUrl = async () => {
        soundCloudCalls += 1;
        return null;
    };
    guildSettingsManager.getSettings = async () => guildSettingsManager.getDefaults(guildId);

    const run = async (query: string): Promise<string[]> => {
        const edits: string[] = [];
        const interaction = {
            inGuild: () => true,
            guildId,
            locale: 'fr',
            member: {
                id: '189457295279783936',
                displayName: 'owner',
                user: { id: '189457295279783936', tag: 'owner' },
                voice: {
                    channelId: 'voice-soundcloud-routing',
                    channel: { id: 'voice-soundcloud-routing' },
                },
            },
            channel: { id: 'text-soundcloud-routing' },
            options: { getString: () => query },
            deferReply: async () => undefined,
            editReply: async (value: { content?: string }) => { edits.push(String(value.content ?? '')); },
            deleteReply: async () => undefined,
        };
        await playCommand.execute(interaction as never);
        return edits;
    };

    try {
        const soundCloudEdits = await run('https://soundcloud.com/skorxh/audio-dealer');
        assert.equal(soundCloudCalls, 1);
        assert.equal(searchCalls, 0);
        assert.match(soundCloudEdits.at(-1) ?? '', /charger cette piste/i);

        const externalEdits = await run('https://open.spotify.com/track/example');
        assert.equal(soundCloudCalls, 1);
        assert.equal(searchCalls, 0);
        assert.match(externalEdits.at(-1) ?? '', /URL non prise en charge/i);

        await run('daft punk harder better faster stronger');
        assert.equal(soundCloudCalls, 1);
        assert.equal(searchCalls, 1);
    } finally {
        youtubeService.searchWithRanking = originalSearch;
        soundCloudService.createTrackFromUrl = originalSoundCloudCreate;
        guildSettingsManager.getSettings = originalGetSettings;
    }
});

test('SoundCloud metadata maps to a provider-safe Track identity and bounded yt-dlp call', async () => {
    let observedArgs: string[] = [];
    const service = new SoundCloudService({
        runJson: async (args: string[]) => {
            observedArgs = args;
            return payload();
        },
    } as any);

    const track = await service.createTrackFromUrl(
        'https://www.soundcloud.com/skorxh/audio-dealer?utm_source=clipboard',
        'Requester',
        '123'
    );

    assert.deepEqual(observedArgs, [
        '--no-warnings',
        '--skip-download',
        '--no-playlist',
        '--ies', 'soundcloud',
        '--dump-single-json',
        '--',
        'https://soundcloud.com/skorxh/audio-dealer',
    ]);
    assert.equal(track?.id, 'soundcloud:2011421339');
    assert.equal(track?.provider, 'soundcloud');
    assert.equal(track?.sourceId, '2011421339');
    assert.equal(track?.canonicalUrl, 'https://soundcloud.com/skorxh/audio-dealer');
    assert.equal(track?.url, track?.canonicalUrl);
    assert.equal(track?.duration, 213);
    assert.equal(track?.channelTitle, '$KORCH');
    assert.equal(track?.channelId, '150292288');
    assert.equal(track?.sourceType, 'url');
    assert.equal(track?.requestedBy, 'Requester');
});

test('SoundCloud serializes resolutions from one guild without blocking another guild', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const service = new SoundCloudService({
        runJson: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => { releases.push(resolve); });
            active -= 1;
            return payload();
        },
    } as any);

    const first = service.createTrackFromUrl(
        'https://soundcloud.com/skorxh/audio-dealer',
        'A',
        '1',
        { scopeKey: 'guild-a' }
    );
    const queuedSameGuild = service.createTrackFromUrl(
        'https://soundcloud.com/skorxh/audio-dealer',
        'B',
        '2',
        { scopeKey: 'guild-a' }
    );
    const parallelOtherGuild = service.createTrackFromUrl(
        'https://soundcloud.com/skorxh/audio-dealer',
        'C',
        '3',
        { scopeKey: 'guild-b' }
    );

    await waitFor(() => releases.length === 2);
    assert.equal(active, 2, 'deux guildes peuvent progresser en parallèle');
    assert.equal(maxActive, 2);
    releases.splice(0).forEach((release) => release());

    await waitFor(() => releases.length === 1);
    assert.equal(active, 1, 'la seconde requête de la même guilde attend son tour');
    releases.shift()?.();

    const tracks = await Promise.all([first, queuedSameGuild, parallelOtherGuild]);
    assert.equal(tracks.every(Boolean), true);
    assert.equal(maxActive, 2);
});

test('short links use allowlisted bodyless redirects before yt-dlp', async () => {
    let requestOptions: any;
    let ytdlpCalls = 0;
    const service = new SoundCloudService(
        {
            runJson: async () => {
                ytdlpCalls += 1;
                return payload();
            },
        } as any,
        (async (options: any) => {
            requestOptions = options;
            return {
                statusCode: 200,
                headers: {},
                body: null,
                finalUrl: 'https://soundcloud.com/skorxh/audio-dealer?si=share',
            };
        }) as any
    );

    const track = await service.createTrackFromUrl('https://on.soundcloud.com/AbC123', 'A', '1');
    assert.equal(track?.canonicalUrl, 'https://soundcloud.com/skorxh/audio-dealer');
    assert.equal(ytdlpCalls, 1);
    assert.deepEqual(requestOptions.allowedDomains, ['soundcloud.com']);
    assert.equal(requestOptions.responseType, 'none');
    assert.equal(requestOptions.maxRedirects, 3);
    assert.equal(requestOptions.maxBytes, 1);
});

test('short links resolving outside a public track never reach yt-dlp', async () => {
    for (const finalUrl of [
        'https://soundcloud.com/skorxh',
        'https://soundcloud.com/skorxh/sets/my-set',
        'https://example.com/skorxh/audio-dealer',
    ]) {
        let ytdlpCalls = 0;
        const service = new SoundCloudService(
            { runJson: async () => { ytdlpCalls += 1; return payload(); } } as any,
            (async () => ({ statusCode: 200, headers: {}, body: null, finalUrl })) as any
        );
        assert.equal(await service.createTrackFromUrl('https://on.soundcloud.com/AbC123', 'A', '1'), null);
        assert.equal(ytdlpCalls, 0);
    }
});

test('short-link redirect loops and timeouts fail cleanly before yt-dlp', async () => {
    for (const failure of [
        new Error('Too many redirects for https://on.soundcloud.com/AbC123'),
        new Error('Request timeout after 5000ms'),
    ]) {
        let ytdlpCalls = 0;
        const service = new SoundCloudService(
            { runJson: async () => { ytdlpCalls += 1; return payload(); } } as any,
            (async () => { throw failure; }) as any
        );

        assert.equal(await service.createTrackFromUrl('https://on.soundcloud.com/AbC123', 'A', '1'), null);
        assert.equal(ytdlpCalls, 0);
    }
});

test('invalid, private, live, or playlist yt-dlp payloads are rejected', async () => {
    const invalidPayloads = [
        payload({ extractor: 'generic', extractor_key: 'Generic' }),
        payload({ extractor: 'generic', extractor_key: 'Soundcloud' }),
        payload({ extractor: 'soundcloud', extractor_key: 'Generic' }),
        payload({ entries: [payload()], _type: 'playlist' }),
        payload({ id: '' }),
        payload({ duration: 0 }),
        payload({ webpage_url: '' }),
        payload({ availability: 'private' }),
        payload({ is_live: true }),
        payload({ webpage_url: 'https://soundcloud.com/skorxh/sets/my-set' }),
    ];

    for (const invalidPayload of invalidPayloads) {
        const service = new SoundCloudService({ runJson: async () => invalidPayload } as any);
        const track = await service.createTrackFromUrl('https://soundcloud.com/skorxh/audio-dealer', 'A', '1');
        assert.equal(track, null);
    }
});

test('short-link cancellation propagates without starting yt-dlp', async () => {
    const controller = new AbortController();
    controller.abort();
    let ytdlpCalls = 0;
    const service = new SoundCloudService(
        { runJson: async () => { ytdlpCalls += 1; return payload(); } } as any,
        (async () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            throw error;
        }) as any
    );

    await assert.rejects(
        service.createTrackFromUrl('https://on.soundcloud.com/AbC123', 'A', '1', { signal: controller.signal }),
        (error: any) => error?.name === 'AbortError'
    );
    assert.equal(ytdlpCalls, 0);
});
