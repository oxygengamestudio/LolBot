import { config } from '../config.js';
import type { PlaylistInfo, SearchResult, Track, YouTubeVideoInfo } from '../types/index.js';
import { httpRequest } from '../utils/httpClient.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { MediaProvider, MediaSearchContext } from './providers/MediaProvider.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const OFFICIAL_KEYWORDS = [
    'official music video',
    'official lyric video',
    'official audio',
    'official video',
    'clip officiel',
    'video officielle',
    'lyric video',
    'vevo',
];
const QUERY_STOP_WORDS = new Set(['a', 'an', 'the', 'de', 'du', 'des', 'et', 'feat', 'featuring', 'with']);
const VERSION_TOKENS = new Set(['cover', 'remix', 'live', 'karaoke', 'instrumental', 'instru', 'reaction', 'spedup', 'nightcore']);
const COMMON_QUERY_TYPOS = new Map<string, string>([
    ['lvoe', 'love'],
    ['lvo', 'love'],
    ['ressurection', 'resurrection'],
    ['resurection', 'resurrection'],
    ['errection', 'erection'],
]);

type PermitWaiter = {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
};

type TimedCacheEntry<T> = {
    expiresAt: number;
    value: T;
};

class AsyncSemaphore {
    private available: number;
    private readonly waiters: PermitWaiter[] = [];

    constructor(private readonly capacity: number) {
        this.available = capacity;
    }

    get idle(): boolean {
        return this.available === this.capacity && this.waiters.length === 0;
    }

    acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(createAbortError());
        }

        if (this.available > 0) {
            this.available -= 1;
            return Promise.resolve(this.createRelease());
        }

        return new Promise((resolve, reject) => {
            const waiter: PermitWaiter = { resolve, reject, signal };
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) {
                        this.waiters.splice(index, 1);
                    }
                    reject(createAbortError());
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }

    private createRelease(): () => void {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;

            while (this.waiters.length > 0) {
                const waiter = this.waiters.shift()!;
                if (waiter.onAbort) {
                    waiter.signal?.removeEventListener('abort', waiter.onAbort);
                }
                if (waiter.signal?.aborted) {
                    waiter.reject(createAbortError());
                    continue;
                }
                waiter.resolve(this.createRelease());
                return;
            }

            this.available = Math.min(this.capacity, this.available + 1);
        };
    }
}

function createAbortError(): Error {
    const error = new Error('Media search aborted');
    error.name = 'AbortError';
    return error;
}

export interface RankedSearchResult extends SearchResult {
    score: number;
}

interface YouTubeThumbnailSet {
    default?: { url?: string };
    high?: { url?: string };
}

interface VideoApiItem {
    id?: string;
    snippet?: {
        title?: string;
        channelTitle?: string;
        channelId?: string;
        thumbnails?: YouTubeThumbnailSet;
    };
    contentDetails?: {
        duration?: string;
    };
    statistics?: {
        viewCount?: string;
    };
}

interface PlaylistItemApi {
    snippet?: {
        title?: string;
        thumbnails?: YouTubeThumbnailSet;
        resourceId?: {
            videoId?: string;
        };
    };
}

interface YouTubeListResponse<TItem> {
    items?: TItem[];
}

export class YouTubeService implements MediaProvider {
    readonly provider = 'youtube';
    private readonly apiKey = config.youtube.apiKey;
    private readonly requestTimeoutMs = 15_000;
    private readonly maxBytes = 2 * 1024 * 1024;
    private readonly allowedDomains = ['googleapis.com', 'youtube.com', 'youtube-nocookie.com', 'youtu.be'] as const;
    private readonly shortsMarkerPattern = /(?:^|[^a-z0-9])(?:shorts|#shorts)(?:$|[^a-z0-9])/i;
    private readonly searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
    private readonly searchCacheTtlMs = 3 * 60 * 1000;
    private readonly searchInFlight = new Map<string, Promise<SearchResult[]>>();
    private readonly videoInfoCache = new Map<string, TimedCacheEntry<YouTubeVideoInfo | null>>();
    private readonly videoInfoInFlight = new Map<string, Promise<YouTubeVideoInfo | null>>();
    private readonly playlistCache = new Map<string, TimedCacheEntry<PlaylistInfo | null>>();
    private readonly playlistInFlight = new Map<string, Promise<PlaylistInfo | null>>();
    private readonly metadataCacheTtlMs = 10 * 60 * 1000;
    private readonly negativeMetadataCacheTtlMs = 30 * 1000;
    private readonly metadataCacheMaxEntries = 256;
    private readonly globalProviderSemaphore = new AsyncSemaphore(4);
    private readonly scopedProviderSemaphores = new Map<string, AsyncSemaphore>();
    private readonly dataApiFailureThreshold = 3;
    private readonly dataApiCooldownMs = 5 * 60 * 1000;
    private dataApiConsecutiveFailures = 0;
    private dataApiUnavailableUntil = 0;
    private warnedUnsafeYtdlpExtraArgsIgnored = false;

    async search(query: string, maxResults = 10, context?: MediaSearchContext): Promise<SearchResult[]> {
        const ranked = await this.searchWithRanking(query, maxResults, context);
        return ranked.map((result) => {
            const { score: _score, ...searchResult } = result;
            return searchResult;
        });
    }

    async searchWithRanking(
        query: string,
        maxResults = 10,
        context?: MediaSearchContext
    ): Promise<RankedSearchResult[]> {
        const normalizedQuery = this.normalizeSearchInput(query);
        const rawResults = await this.searchIndependent(normalizedQuery, maxResults, context);
        return this.rankSearchResults(normalizedQuery, rawResults)
            .sort((a, b) => (b.score - a.score) || ((b.viewCount ?? 0) - (a.viewCount ?? 0)))
            .filter((result) => result.score >= 0)
            .slice(0, maxResults);
    }

    shouldAutoSelect(results: RankedSearchResult[], query: string): boolean {
        if (results.length === 0) {
            return false;
        }
        if (results.length === 1) {
            return true;
        }

        const queryTokens = this.extractRankingTokens(query);
        const hasSpecificVersionToken = queryTokens.some((token) => VERSION_TOKENS.has(token));
        const [first, second] = results;
        const top = first?.score ?? 0;
        const secondScore = second?.score ?? 0;
        const fullText = this.normalizeRankingText(`${first?.title ?? ''} ${first?.channelTitle ?? ''}`);
        const hasTitleMatch = queryTokens.every((token) => fullText.includes(token));

        if (hasSpecificVersionToken) {
            return top >= 110 && top - secondScore >= 50;
        }

        return top >= 120 && hasTitleMatch && top - secondScore >= 140;
    }

    private async searchIndependent(
        query: string,
        maxResults = 10,
        context?: MediaSearchContext
    ): Promise<SearchResult[]> {
        const cacheKey = `${query}:${maxResults}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.results;
        }

        const inFlightKey = `${context?.scopeKey ?? 'shared'}:${context?.signal ? 'abortable' : 'stable'}:${cacheKey}`;
        const current = this.searchInFlight.get(inFlightKey);
        if (current) {
            return current;
        }

        const pending = this.withProviderPermit(context, () => this.fetchIndependentSearch(query, maxResults, context))
            .finally(() => {
                if (this.searchInFlight.get(inFlightKey) === pending) {
                    this.searchInFlight.delete(inFlightKey);
                }
            });
        this.searchInFlight.set(inFlightKey, pending);
        return pending;
    }

    private async fetchIndependentSearch(
        query: string,
        maxResults: number,
        context?: MediaSearchContext
    ): Promise<SearchResult[]> {
        this.throwIfAborted(context?.signal);
        const cacheKey = `${query}:${maxResults}`;

        const unique = new Map<string, SearchResult>();
        const webLimit = Math.min(Math.max(maxResults * 2, maxResults), 20);
        const webResults = await this.searchWithYouTubeWeb(query, webLimit, context?.signal).catch((error) => {
            console.warn('YouTube web search failed, falling back to yt-dlp:', this.formatError(error));
            return [] as SearchResult[];
        });
        this.throwIfAborted(context?.signal);
        this.appendUniqueSearchResults(unique, webResults);

        if (unique.size < Math.min(maxResults, 5)) {
            const ytdlpResults = await this.searchWithYtdlp(query, Math.min(Math.max(maxResults, 10), 15), context)
                .catch(() => [] as SearchResult[]);
            this.throwIfAborted(context?.signal);
            this.appendUniqueSearchResults(unique, ytdlpResults);
        }

        if (unique.size < Math.min(maxResults, 3)) {
            for (const variant of this.buildInflectedSearchVariants(query)) {
                const variantResults = await this.searchWithYtdlp(variant, Math.min(Math.max(maxResults, 10), 15), context)
                    .catch(() => [] as SearchResult[]);
                this.throwIfAborted(context?.signal);
                this.appendUniqueSearchResults(unique, variantResults);
                if (unique.size >= Math.min(maxResults, 3)) {
                    break;
                }
            }
        }

        const results = Array.from(unique.values());
        this.setSearchCache(cacheKey, results);
        return results;
    }

    private async withProviderPermit<T>(context: MediaSearchContext | undefined, operation: () => Promise<T>): Promise<T> {
        const scopeKey = context?.scopeKey?.trim() || 'unscoped';
        let scoped = this.scopedProviderSemaphores.get(scopeKey);
        if (!scoped) {
            scoped = new AsyncSemaphore(1);
            this.scopedProviderSemaphores.set(scopeKey, scoped);
        }

        let releaseScope: (() => void) | undefined;
        let releaseGlobal: (() => void) | undefined;
        try {
            releaseScope = await scoped.acquire(context?.signal);
            releaseGlobal = await this.globalProviderSemaphore.acquire(context?.signal);
            this.throwIfAborted(context?.signal);
            return await operation();
        } finally {
            releaseGlobal?.();
            releaseScope?.();
            if (scoped.idle && this.scopedProviderSemaphores.get(scopeKey) === scoped) {
                this.scopedProviderSemaphores.delete(scopeKey);
            }
        }
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw createAbortError();
        }
    }

    private appendUniqueSearchResults(unique: Map<string, SearchResult>, results: SearchResult[]): void {
        for (const result of results) {
            if (!unique.has(result.id)) {
                unique.set(result.id, result);
            }
        }
    }

    private setSearchCache(key: string, results: SearchResult[]): void {
        if (this.searchCache.size >= 100) {
            const oldestKey = this.searchCache.keys().next().value;
            if (oldestKey) {
                this.searchCache.delete(oldestKey);
            }
        }

        this.searchCache.set(key, {
            expiresAt: Date.now() + this.searchCacheTtlMs,
            results,
        });
    }

    private async searchWithYouTubeWeb(
        query: string,
        maxResults: number,
        signal?: AbortSignal
    ): Promise<SearchResult[]> {
        const params = new URLSearchParams({
            search_query: query,
            hl: 'fr',
            gl: 'FR',
        });
        const searchUrl = `https://www.youtube.com/results?${params.toString()}&sp=EgIQAQ%3D%3D`;
        const response = await httpRequest({
            url: searchUrl,
            allowedDomains: this.allowedDomains,
            timeoutMs: 8_000,
            maxBytes: 8 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            signal,
        });
        const html = typeof response.body === 'string' ? response.body : response.body.toString('utf8');
        const initialData = this.extractYtInitialData(html);
        if (!initialData) {
            return [];
        }

        return this.collectVideoRenderers(initialData, Math.max(maxResults * 3, maxResults))
            .map((renderer) => this.searchResultFromVideoRenderer(renderer))
            .filter((result: SearchResult | null): result is SearchResult => result !== null)
            .filter((result) => !this.hasShortsMarker(`${result.title} ${result.channelTitle ?? ''}`))
            .map((result, index) => ({ ...result, sourceRank: index + 1 }))
            .slice(0, maxResults);
    }

    private extractYtInitialData(html: string): unknown | null {
        const markers = [
            'var ytInitialData =',
            'window["ytInitialData"] =',
            'ytInitialData =',
        ];

        for (const marker of markers) {
            const markerIndex = html.indexOf(marker);
            if (markerIndex < 0) {
                continue;
            }

            const start = html.indexOf('{', markerIndex + marker.length);
            if (start < 0) {
                continue;
            }

            const json = this.extractBalancedJson(html, start);
            if (!json) {
                continue;
            }

            try {
                return JSON.parse(json);
            } catch {
                continue;
            }
        }

        return null;
    }

    private extractBalancedJson(text: string, start: number): string | null {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < text.length; i += 1) {
            const char = text[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                depth += 1;
            } else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, i + 1);
                }
            }
        }

        return null;
    }

    private collectVideoRenderers(root: unknown, maxRenderers: number): any[] {
        const renderers: any[] = [];
        const queue: unknown[] = [root];
        const maxNodes = 25_000;

        for (let index = 0; index < queue.length && index < maxNodes && renderers.length < maxRenderers; index += 1) {
            const current = queue[index];
            if (!current || typeof current !== 'object') {
                continue;
            }

            const record = current as Record<string, any>;
            if (record.videoRenderer) {
                renderers.push(record.videoRenderer);
                continue;
            }

            for (const value of Object.values(record)) {
                if (value && typeof value === 'object') {
                    queue.push(value);
                }
            }
        }

        return renderers;
    }

    private searchResultFromVideoRenderer(renderer: any): SearchResult | null {
        const id = this.normalizeVideoId(renderer?.videoId);
        if (!id) {
            return null;
        }

        const title = this.textFromRuns(renderer?.title);
        if (!title) {
            return null;
        }

        const duration = this.textFromRuns(renderer?.lengthText);
        const channelTitle = this.textFromRuns(renderer?.ownerText)
            || this.textFromRuns(renderer?.longBylineText)
            || this.textFromRuns(renderer?.shortBylineText);

        return {
            id,
            title,
            duration,
            durationSeconds: duration ? this.parseDurationToSeconds(duration) : 0,
            thumbnail: this.getRendererThumbnail(renderer),
            channelTitle,
            channelId: this.extractRendererChannelId(renderer),
            viewCount: this.parseHumanViewCount(
                this.textFromRuns(renderer?.viewCountText) || this.textFromRuns(renderer?.shortViewCountText)
            ),
        };
    }

    private textFromRuns(value: any): string {
        if (typeof value?.simpleText === 'string') {
            return this.decodeHtmlEntities(value.simpleText).trim();
        }

        if (Array.isArray(value?.runs)) {
            return this.decodeHtmlEntities(
                value.runs
                    .map((run: any) => typeof run?.text === 'string' ? run.text : '')
                    .join('')
            ).trim();
        }

        return '';
    }

    private getRendererThumbnail(renderer: any): string {
        const thumbnails = renderer?.thumbnail?.thumbnails;
        if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
            return '';
        }

        const thumbnail = thumbnails
            .filter((candidate: any) => typeof candidate?.url === 'string')
            .sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0];
        return thumbnail?.url ?? '';
    }

    private extractRendererChannelId(renderer: any): string | undefined {
        const runs = renderer?.ownerText?.runs ?? renderer?.longBylineText?.runs ?? renderer?.shortBylineText?.runs;
        if (!Array.isArray(runs)) {
            return undefined;
        }

        const browseId = runs
            .map((run: any) => run?.navigationEndpoint?.browseEndpoint?.browseId)
            .find((value: unknown) => typeof value === 'string');
        return typeof browseId === 'string' ? browseId : undefined;
    }

    private parseHumanViewCount(text: string): number | undefined {
        const normalized = text
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/(?<=\d)[\s\u00a0\u202f](?=\d)/g, '')
            .replace(/[\u00a0\u202f]/g, ' ')
            .replace(',', '.');
        const match = normalized.match(/(\d+(?:\.\d+)?)\s*(k|m|b|mio|million|millions|milliard|milliards)?/);
        if (!match) {
            return undefined;
        }

        const amount = Number.parseFloat(match[1]);
        if (!Number.isFinite(amount)) {
            return undefined;
        }

        const unit = match[2] ?? '';
        const multiplier = unit === 'k'
            ? 1_000
            : unit === 'm' || unit === 'mio' || unit.startsWith('million')
                ? 1_000_000
                : unit === 'b' || unit.startsWith('milliard')
                    ? 1_000_000_000
                    : 1;

        return Math.floor(amount * multiplier);
    }

    isYouTubeUrl(url: string): boolean {
        const patterns = [
            /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
            /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=[\w-]+/,
            /^(https?:\/\/)?youtu\.be\/[\w-]+/,
            /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
        ];
        return patterns.some((pattern) => pattern.test(url));
    }

    isPlaylistUrl(url: string): boolean {
        return /[?&]list=[\w-]+/.test(url);
    }

    extractVideoId(url: string): string | null {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/,
            /^([\w-]{11})$/,
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match?.[1]) {
                return match[1];
            }
        }

        return null;
    }

    extractPlaylistId(url: string): string | null {
        const match = url.match(/[?&]list=([\w-]+)/);
        return match?.[1] ?? null;
    }

    async getVideoInfo(videoId: string, context?: MediaSearchContext): Promise<YouTubeVideoInfo | null> {
        const cached = this.getMetadataCacheValue(this.videoInfoCache, videoId);
        if (cached.hit) {
            return cached.value;
        }

        const inFlightKey = this.getMetadataInFlightKey(videoId, context);
        const existing = this.videoInfoInFlight.get(inFlightKey);
        if (existing) {
            return existing;
        }

        const pending = this.withProviderPermit(context, () => this.fetchVideoInfo(videoId, context?.signal))
            .then((value) => {
                this.setMetadataCacheValue(this.videoInfoCache, videoId, value);
                return value;
            })
            .finally(() => {
                if (this.videoInfoInFlight.get(inFlightKey) === pending) {
                    this.videoInfoInFlight.delete(inFlightKey);
                }
            });
        this.videoInfoInFlight.set(inFlightKey, pending);
        return pending;
    }

    private async fetchVideoInfo(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoInfo | null> {
        this.throwIfAborted(signal);
        if (!this.canUseDataApi()) {
            return this.getVideoInfoWithYtdlp(videoId, signal);
        }

        try {
            const info = await this.getVideoInfoWithGoogle(videoId, signal);
            this.noteDataApiSuccess();
            return info;
        } catch (error) {
            this.throwIfAborted(signal);
            this.noteDataApiFailure(error);
            console.warn('YouTube Data API video lookup failed, falling back to yt-dlp:', this.formatError(error));
            return this.getVideoInfoWithYtdlp(videoId, signal);
        }
    }

    private async getVideoInfoWithGoogle(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoInfo | null> {
        const params = new URLSearchParams({
            part: 'snippet,contentDetails',
            id: videoId,
            key: this.apiKey!,
        });

        const url = `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
        const data = await this.fetchJson<YouTubeListResponse<VideoApiItem>>(url, signal);
        const item = data.items?.[0];
        if (!item?.id || !item.snippet || !item.contentDetails?.duration) {
            return null;
        }

        return {
            id: item.id,
            title: this.decodeHtmlEntities(item.snippet.title ?? 'Unknown title'),
            duration: this.parseDurationToSeconds(item.contentDetails.duration),
            thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
            channelTitle: this.decodeHtmlEntities(item.snippet.channelTitle ?? ''),
            channelId: item.snippet.channelId,
        };
    }

    async getPlaylistTracks(
        playlistId: string,
        requestedBy: string,
        requestedById: string,
        context?: MediaSearchContext
    ): Promise<PlaylistInfo | null> {
        const cached = this.getMetadataCacheValue(this.playlistCache, playlistId);
        if (cached.hit) {
            return this.clonePlaylistForRequester(cached.value, requestedBy, requestedById);
        }

        const inFlightKey = this.getMetadataInFlightKey(playlistId, context);
        const existing = this.playlistInFlight.get(inFlightKey);
        if (existing) {
            return this.clonePlaylistForRequester(await existing, requestedBy, requestedById);
        }

        const pending = this.withProviderPermit(context, () => this.fetchPlaylistTracks(playlistId, context?.signal))
            .then((value) => {
                this.setMetadataCacheValue(this.playlistCache, playlistId, value);
                return value;
            })
            .finally(() => {
                if (this.playlistInFlight.get(inFlightKey) === pending) {
                    this.playlistInFlight.delete(inFlightKey);
                }
            });
        this.playlistInFlight.set(inFlightKey, pending);
        return this.clonePlaylistForRequester(await pending, requestedBy, requestedById);
    }

    private async fetchPlaylistTracks(playlistId: string, signal?: AbortSignal): Promise<PlaylistInfo | null> {
        this.throwIfAborted(signal);
        const cacheRequester = 'cache';
        const cacheRequesterId = '0';
        if (!this.canUseDataApi()) {
            return this.getPlaylistTracksWithYtdlp(playlistId, cacheRequester, cacheRequesterId, signal);
        }

        try {
            const playlist = await this.getPlaylistTracksWithGoogle(playlistId, cacheRequester, cacheRequesterId, signal);
            this.noteDataApiSuccess();
            return playlist;
        } catch (error) {
            this.throwIfAborted(signal);
            this.noteDataApiFailure(error);
            console.warn('YouTube Data API playlist lookup failed, falling back to yt-dlp:', this.formatError(error));
            return this.getPlaylistTracksWithYtdlp(playlistId, cacheRequester, cacheRequesterId, signal);
        }
    }

    private clonePlaylistForRequester(
        playlist: PlaylistInfo | null,
        requestedBy: string,
        requestedById: string
    ): PlaylistInfo | null {
        if (!playlist) return null;
        return {
            ...playlist,
            tracks: playlist.tracks.map((track) => ({ ...track, requestedBy, requestedById })),
        };
    }

    private getMetadataInFlightKey(key: string, context?: MediaSearchContext): string {
        return `${context?.scopeKey?.trim() || 'unscoped'}:${context?.signal ? 'abortable' : 'stable'}:${key}`;
    }

    private getMetadataCacheValue<T>(
        cache: Map<string, TimedCacheEntry<T>>,
        key: string
    ): { hit: true; value: T } | { hit: false } {
        const now = Date.now();
        this.pruneExpiredMetadataCache(cache, now);
        const cached = cache.get(key);
        if (!cached) {
            return { hit: false };
        }

        // Refresh insertion order so bounded eviction behaves as a small LRU.
        cache.delete(key);
        cache.set(key, cached);
        return { hit: true, value: cached.value };
    }

    private setMetadataCacheValue<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T): void {
        const now = Date.now();
        this.pruneExpiredMetadataCache(cache, now);
        cache.delete(key);
        cache.set(key, {
            expiresAt: now + (value === null ? this.negativeMetadataCacheTtlMs : this.metadataCacheTtlMs),
            value,
        });

        while (cache.size > this.metadataCacheMaxEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            cache.delete(oldestKey);
        }
    }

    private pruneExpiredMetadataCache<T>(cache: Map<string, TimedCacheEntry<T>>, now: number): void {
        for (const [key, entry] of cache) {
            if (entry.expiresAt <= now) {
                cache.delete(key);
            }
        }
    }

    private canUseDataApi(): boolean {
        return Boolean(this.apiKey) && Date.now() >= this.dataApiUnavailableUntil;
    }

    private noteDataApiSuccess(): void {
        this.dataApiConsecutiveFailures = 0;
        this.dataApiUnavailableUntil = 0;
    }

    private noteDataApiFailure(error: unknown): void {
        this.dataApiConsecutiveFailures += 1;
        const message = this.formatError(error).toLowerCase();
        const quotaLimited = /(?:quota|rate.?limit|too many requests|\b403\b|\b429\b)/.test(message);
        if (quotaLimited || this.dataApiConsecutiveFailures >= this.dataApiFailureThreshold) {
            this.dataApiUnavailableUntil = Date.now() + (quotaLimited ? 15 * 60 * 1000 : this.dataApiCooldownMs);
        }
    }

    private async getPlaylistTracksWithGoogle(
        playlistId: string,
        requestedBy: string,
        requestedById: string,
        signal?: AbortSignal
    ): Promise<PlaylistInfo | null> {
        const playlistParams = new URLSearchParams({
            part: 'snippet',
            id: playlistId,
            key: this.apiKey!,
        });
        const playlistUrl = `${YOUTUBE_API_BASE}/playlists?${playlistParams.toString()}`;
        const playlistData = await this.fetchJson<YouTubeListResponse<{ snippet?: { title?: string } }>>(playlistUrl, signal);
        const playlist = playlistData.items?.[0];
        if (!playlist?.snippet?.title) {
            return null;
        }

        const itemsParams = new URLSearchParams({
            part: 'snippet',
            playlistId,
            maxResults: config.audio.maxPlaylistTracks.toString(),
            key: this.apiKey!,
        });
        const itemsUrl = `${YOUTUBE_API_BASE}/playlistItems?${itemsParams.toString()}`;
        const itemsData = await this.fetchJson<YouTubeListResponse<PlaylistItemApi>>(itemsUrl, signal);
        const items = itemsData.items ?? [];
        if (items.length === 0) {
            return null;
        }

        const videoIds = items
            .map((item) => item.snippet?.resourceId?.videoId)
            .filter((value): value is string => Boolean(value));
        if (videoIds.length === 0) {
            return null;
        }

        const detailsParams = new URLSearchParams({
            part: 'contentDetails',
            id: videoIds.join(','),
            key: this.apiKey!,
        });
        const detailsUrl = `${YOUTUBE_API_BASE}/videos?${detailsParams.toString()}`;
        const detailsData = await this.fetchJson<YouTubeListResponse<VideoApiItem>>(detailsUrl, signal);
        const durationMap = new Map<string, number>();
        for (const item of detailsData.items ?? []) {
            if (item.id && item.contentDetails?.duration) {
                durationMap.set(item.id, this.parseDurationToSeconds(item.contentDetails.duration));
            }
        }

        const tracks: Track[] = items
            .filter((item): item is PlaylistItemApi & { snippet: NonNullable<PlaylistItemApi['snippet']> } =>
                Boolean(item.snippet?.resourceId?.videoId)
            )
            .map((item) => {
                const videoId = item.snippet.resourceId!.videoId!;
                return this.withYouTubeIdentity({
                    id: videoId,
                    title: this.decodeHtmlEntities(item.snippet.title ?? 'Unknown title'),
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    duration: durationMap.get(videoId) ?? 0,
                    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
                    sourceType: 'playlist',
                    requestedBy,
                    requestedById,
                });
            });

        return {
            id: playlistId,
            title: this.decodeHtmlEntities(playlist.snippet.title),
            itemCount: tracks.length,
            tracks,
        };
    }

    private async searchWithYtdlp(
        query: string,
        maxResults: number,
        context?: MediaSearchContext
    ): Promise<SearchResult[]> {
        const unique = new Map<string, SearchResult>();
        for (const prefix of ['ytsearch'] as const) {
            const results = await this.searchWithYtdlpPrefix(prefix, query, maxResults, context);
            for (const result of results) {
                if (!unique.has(result.id)) {
                    unique.set(result.id, result);
                }
            }
            if (unique.size >= maxResults) {
                break;
            }
        }
        return Array.from(unique.values()).slice(0, maxResults);
    }

    private async searchWithYtdlpPrefix(
        prefix: 'ytmsearch' | 'ytsearch',
        query: string,
        maxResults: number,
        context?: MediaSearchContext
    ): Promise<SearchResult[]> {
        try {
            const payload = await this.runYtdlpJson([
                '--no-warnings',
                '--skip-download',
                '--flat-playlist',
                '--dump-single-json',
                `${prefix}${Math.max(1, maxResults)}:${query}`,
            ], context?.signal);

            const entries = Array.isArray(payload?.entries) ? payload.entries : [];
            return entries
                .map((entry: any) => this.searchResultFromYtdlpEntry(entry))
                .filter((entry: SearchResult | null): entry is SearchResult => entry !== null)
                .slice(0, maxResults);
        } catch (error) {
            console.warn(`yt-dlp ${prefix} fallback failed:`, this.formatError(error));
            return [];
        }
    }

    private async getVideoInfoWithYtdlp(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoInfo | null> {
        try {
            const payload = await this.runYtdlpJson([
                '--no-warnings',
                '--skip-download',
                '--no-playlist',
                '--dump-single-json',
                `https://www.youtube.com/watch?v=${videoId}`,
            ], signal);

            const id = this.normalizeVideoId(payload?.id ?? videoId);
            if (!id) {
                return null;
            }

            return {
                id,
                title: this.decodeHtmlEntities(String(payload?.title ?? id)),
                duration: this.coerceDurationSeconds(payload?.duration),
                thumbnail: this.getYtdlpThumbnail(payload),
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            console.warn('yt-dlp video lookup fallback failed:', this.formatError(error));
            return null;
        }
    }

    private async getPlaylistTracksWithYtdlp(
        playlistId: string,
        requestedBy: string,
        requestedById: string,
        signal?: AbortSignal
    ): Promise<PlaylistInfo | null> {
        try {
            const payload = await this.runYtdlpJson([
                '--no-warnings',
                '--skip-download',
                '--flat-playlist',
                '--playlist-end',
                config.audio.maxPlaylistTracks.toString(),
                '--dump-single-json',
                `https://www.youtube.com/playlist?list=${playlistId}`,
            ], signal);

            const entries = Array.isArray(payload?.entries) ? payload.entries : [];
            const tracks: Track[] = entries
                .map((entry: any) => this.trackFromYtdlpEntry(entry, requestedBy, requestedById))
                .filter((track: Track | null): track is Track => track !== null)
                .slice(0, config.audio.maxPlaylistTracks);

            if (tracks.length === 0) {
                return null;
            }

            return {
                id: playlistId,
                title: this.decodeHtmlEntities(String(payload?.title ?? playlistId)),
                itemCount: tracks.length,
                tracks,
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            console.warn('yt-dlp playlist fallback failed:', this.formatError(error));
            return null;
        }
    }

    private searchResultFromYtdlpEntry(entry: any): SearchResult | null {
        const id = this.normalizeVideoId(entry?.id ?? entry?.url);
        if (!id) {
            return null;
        }

        return {
            id,
            title: this.decodeHtmlEntities(String(entry?.title ?? id)),
            duration: this.formatDurationFromSeconds(this.coerceDurationSeconds(entry?.duration)),
            durationSeconds: this.coerceDurationSeconds(entry?.duration),
            thumbnail: this.getYtdlpThumbnail(entry),
            channelTitle: String(entry?.channel ?? entry?.uploader ?? ''),
            channelId: typeof entry?.channel_id === 'string' ? entry.channel_id : undefined,
            viewCount: this.coerceViewCount(entry?.view_count),
        };
    }

    private trackFromYtdlpEntry(entry: any, requestedBy: string, requestedById: string): Track | null {
        const id = this.normalizeVideoId(entry?.id ?? entry?.url);
        if (!id) {
            return null;
        }

        return this.withYouTubeIdentity({
            id,
            title: this.decodeHtmlEntities(String(entry?.title ?? id)),
            url: `https://www.youtube.com/watch?v=${id}`,
            duration: this.coerceDurationSeconds(entry?.duration),
            thumbnail: this.getYtdlpThumbnail(entry),
            channelTitle: String(entry?.channel ?? entry?.uploader ?? ''),
            channelId: typeof entry?.channel_id === 'string' ? entry.channel_id : undefined,
            sourceType: 'playlist',
            requestedBy,
            requestedById,
        });
    }

    async createTrackFromSearch(result: SearchResult, requestedBy: string, requestedById: string): Promise<Track> {
        return this.withYouTubeIdentity({
            id: result.id,
            title: result.title,
            url: `https://www.youtube.com/watch?v=${result.id}`,
            duration: this.parseDurationToSeconds(result.duration),
            thumbnail: result.thumbnail,
            channelTitle: result.channelTitle,
            channelId: result.channelId,
            sourceType: 'search',
            requestedBy,
            requestedById,
        });
    }

    async createTrackFromUrl(
        url: string,
        requestedBy: string,
        requestedById: string,
        context?: MediaSearchContext
    ): Promise<Track | null> {
        const videoId = this.extractVideoId(url);
        if (!videoId) {
            return null;
        }

        const info = await this.getVideoInfo(videoId, context);
        if (!info) {
            return null;
        }

        return this.withYouTubeIdentity({
            id: info.id,
            title: info.title,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            duration: info.duration,
            thumbnail: info.thumbnail,
            channelTitle: info.channelTitle,
            channelId: info.channelId,
            sourceType: 'url',
            requestedBy,
            requestedById,
        });
    }

    private withYouTubeIdentity(track: Track): Track {
        const canonicalUrl = `https://www.youtube.com/watch?v=${track.id}`;
        return {
            ...track,
            provider: 'youtube',
            sourceId: track.id,
            canonicalUrl,
            isLive: track.isLive ?? false,
            url: canonicalUrl,
        };
    }

    private rankSearchResults(query: string, results: SearchResult[]): RankedSearchResult[] {
        const tokens = this.extractRankingTokens(query);
        const normalizedQuery = this.normalizeRankingText(query);
        const explicit = {
            cover: tokens.includes('cover'),
            remix: tokens.includes('remix'),
            live: tokens.includes('live'),
            nightcore: tokens.includes('nightcore'),
            karaoke: tokens.includes('karaoke'),
            instrumental: tokens.includes('instrumental') || tokens.includes('instru'),
            reaction: tokens.includes('reaction'),
            spedup: tokens.includes('spedup') || tokens.includes('sped'),
        };

        return results.map((result) => ({
            ...result,
            score: this.scoreSearchResult(result, tokens, explicit, normalizedQuery),
        })).sort((a, b) => (b.score - a.score) || ((b.viewCount ?? 0) - (a.viewCount ?? 0)));
    }

    private scoreSearchResult(
        result: SearchResult,
        queryTokens: string[],
        explicit: {
            cover: boolean;
            remix: boolean;
            live: boolean;
            nightcore: boolean;
            karaoke: boolean;
            instrumental: boolean;
            reaction: boolean;
            spedup: boolean;
        },
        normalizedQuery: string
    ): number {
        const title = this.normalizeRankingText(result.title);
        const channel = this.normalizeRankingText(result.channelTitle ?? '');
        const fullText = `${title} ${channel}`;
        const titleTokens = this.tokenizeRankingText(title);
        const fullTextTokens = this.tokenizeRankingText(fullText);
        const durationSeconds = result.durationSeconds ?? this.parseDurationToSeconds(result.duration);
        const coreTokens = queryTokens.filter((token) => !VERSION_TOKENS.has(token));
        const queryPhrase = coreTokens.join(' ');
        const compactTitle = this.compactRankingText(title);
        const compactQuery = this.compactRankingText(normalizedQuery);
        let score = 20;

        if (normalizedQuery && title === normalizedQuery) {
            score += 1200;
        } else if (compactQuery && compactTitle === compactQuery) {
            score += 1100;
        } else if (normalizedQuery && title.includes(normalizedQuery)) {
            score += 520;
        }

        if (queryPhrase.length > 0 && title.includes(queryPhrase)) {
            score += 260;
        }
        if (queryPhrase.length > 0 && fullText.includes(queryPhrase)) {
            score += 90;
        }
        if (coreTokens.length > 1 && this.hasOrderedTokenMatch(title, coreTokens)) {
            score += 240;
        }

        for (const keyword of OFFICIAL_KEYWORDS) {
            if (title.includes(keyword)) {
                score += keyword.includes('lyric') ? 130 : 170;
            }
        }

        if (channel.includes('vevo')) score += 130;
        if (channel.includes('official')) score += 90;
        if (title.includes('vevo')) score += 90;
        if (title.includes('official')) score += 70;

        const matchedTitleTokens = coreTokens.filter((token) => this.hasRankingToken(titleTokens, token));
        const matchedFullTokens = coreTokens.filter((token) => this.hasRankingToken(fullTextTokens, token));
        const missingFullTokens = coreTokens.filter((token) => !this.hasRankingToken(fullTextTokens, token));
        const missingTitleTokens = coreTokens.filter((token) => !this.hasRankingToken(titleTokens, token));
        score += matchedFullTokens.length * 34;
        score += matchedTitleTokens.length * 24;
        if (coreTokens.length > 0 && matchedTitleTokens.length === coreTokens.length) {
            score += coreTokens.length >= 2 ? 180 : 70;
        }
        score -= missingFullTokens.length * (coreTokens.length >= 2 ? 620 : 130);
        score -= missingTitleTokens.length * (coreTokens.length >= 2 ? 180 : 20);

        const viewCount = result.viewCount ?? 0;
        if (viewCount > 0) {
            score += Math.min(260, Math.log10(viewCount + 1) * 32);
            score += Math.min(260, viewCount / 1_000_000 * 6);
        }

        if (result.sourceRank) {
            score += Math.max(0, 360 - result.sourceRank * 25);
        }

        if (fullText.includes('cover') && !explicit.cover) score -= 260;
        if (fullText.includes('remix') && !explicit.remix) score -= 110;
        if (fullText.includes('live') && !explicit.live) score -= 90;
        if (fullText.includes('nightcore') && !explicit.nightcore) score -= 120;
        if (fullText.includes('karaoke') && !explicit.karaoke) score -= 380;
        if ((fullText.includes('instrumental') || fullText.includes('instru')) && !explicit.instrumental) score -= 300;
        if ((fullText.includes('vocals only') || fullText.includes('lyrics only')) && !explicit.instrumental) score -= 220;
        if (fullText.includes('reaction') && !explicit.reaction) score -= 120;
        if ((fullText.includes('sped up') || fullText.includes('spedup')) && !explicit.spedup) score -= 100;

        if (durationSeconds > 0 && durationSeconds <= 20) score -= 160;
        else if (durationSeconds > 0 && durationSeconds <= 45) score -= 70;
        else if (durationSeconds > 0 && durationSeconds <= 75) score -= 30;

        if (this.hasShortsMarker(fullText)) score -= 120;

        return score;
    }

    private buildInflectedSearchVariants(query: string): string[] {
        const normalized = this.normalizeRankingText(query);
        const tokens = normalized.split(/\s+/).filter(Boolean);
        if (tokens.length !== 2) {
            return [];
        }

        const [first, second] = tokens;
        if (first.length <= 3 || second.length <= 2) {
            return [];
        }

        if (first.endsWith('s')) {
            return [`${first.slice(0, -1)} ${second}`];
        }

        return [`${first}s ${second}`];
    }

    private extractRankingTokens(query: string): string[] {
        return this.normalizeRankingText(query)
            .split(/\s+/)
            .map((token) => COMMON_QUERY_TYPOS.get(token) ?? token)
            .map((token) => token === 'sped' || token === 'spedup' ? 'spedup' : token)
            .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
    }

    private normalizeSearchInput(query: string): string {
        const tokens = this.normalizeRankingText(query)
            .split(/\s+/)
            .filter(Boolean)
            .map((token) => COMMON_QUERY_TYPOS.get(token) ?? token);
        return tokens.join(' ') || query.trim();
    }

    private normalizeRankingText(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private compactRankingText(text: string): string {
        return this.normalizeRankingText(text).replace(/\s+/g, '');
    }

    private tokenizeRankingText(text: string): string[] {
        return this.normalizeRankingText(text)
            .split(/\s+/)
            .filter(Boolean);
    }

    private hasRankingToken(tokens: string[], queryToken: string): boolean {
        return tokens.some((token) => this.rankingTokensMatch(token, queryToken));
    }

    private hasOrderedTokenMatch(text: string, queryTokens: string[]): boolean {
        const textTokens = this.tokenizeRankingText(text);
        if (queryTokens.length === 0 || textTokens.length < queryTokens.length) {
            return false;
        }

        for (let i = 0; i <= textTokens.length - queryTokens.length; i += 1) {
            const matches = queryTokens.every((queryToken, offset) =>
                this.rankingTokensMatch(textTokens[i + offset], queryToken)
            );
            if (matches) {
                return true;
            }
        }

        return false;
    }

    private rankingTokensMatch(candidateToken: string, queryToken: string): boolean {
        if (candidateToken === queryToken) {
            return true;
        }
        if (candidateToken.length > 3 && candidateToken.endsWith('s') && candidateToken.slice(0, -1) === queryToken) {
            return true;
        }
        if (queryToken.length > 3 && queryToken.endsWith('s') && queryToken.slice(0, -1) === candidateToken) {
            return true;
        }
        if (candidateToken.endsWith('ies') && `${candidateToken.slice(0, -3)}y` === queryToken) {
            return true;
        }
        if (queryToken.endsWith('ies') && `${queryToken.slice(0, -3)}y` === candidateToken) {
            return true;
        }
        return false;
    }

    private hasShortsMarker(text: string): boolean {
        return this.shortsMarkerPattern.test(this.normalizeSearchText(text));
    }

    private getYtdlpPath(): string {
        const envYtdlp = process.env.YTDLP_PATH;
        if (envYtdlp) {
            return envYtdlp;
        }

        const localYtdlpPath = join(config.paths.data, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        return existsSync(localYtdlpPath) ? localYtdlpPath : 'yt-dlp';
    }

    private runYtdlpJson(args: string[], signal?: AbortSignal): Promise<any> {
        return this.runYtdlpText(args, signal).then((payload) => {
            const trimmed = payload.trim();
            if (!trimmed) {
                throw new Error('yt-dlp returned no JSON payload');
            }

            try {
                return JSON.parse(trimmed);
            } catch {
                throw new Error('yt-dlp returned invalid JSON');
            }
        });
    }

    private runYtdlpText(args: string[], signal?: AbortSignal): Promise<string> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }

            const ytdlp = spawn(this.getYtdlpPath(), [...this.getYtdlpRuntimeArgs(), ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            const timeoutMs = 20_000;
            const killGraceMs = 2_000;
            const maxStdoutBytes = 8 * 1024 * 1024;
            const maxStderrBytes = 512 * 1024;
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;
            let terminalError: Error | undefined;
            let killTimer: NodeJS.Timeout | undefined;

            const cleanup = (): void => {
                clearTimeout(timeout);
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            };

            const terminate = (): void => {
                if (ytdlp.exitCode !== null || ytdlp.killed) {
                    return;
                }
                ytdlp.kill('SIGTERM');
                killTimer = setTimeout(() => {
                    if (ytdlp.exitCode === null) {
                        ytdlp.kill('SIGKILL');
                    }
                }, killGraceMs);
                killTimer.unref?.();
            };

            const finish = (error?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                    return;
                }
                resolve(Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'));
            };

            const failAndTerminate = (error: Error): void => {
                if (settled || terminalError) {
                    return;
                }
                terminalError = error;
                terminate();
                ytdlp.stdout?.resume();
                ytdlp.stderr?.resume();
            };

            const onAbort = (): void => {
                failAndTerminate(createAbortError());
            };

            const timeout = setTimeout(() => {
                failAndTerminate(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timeout.unref?.();

            ytdlp.stdout?.on('data', (data) => {
                if (settled || terminalError) {
                    return;
                }
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                stdoutBytes += chunk.length;
                if (stdoutBytes > maxStdoutBytes) {
                    failAndTerminate(new Error(`yt-dlp stdout exceeded ${maxStdoutBytes} bytes`));
                    return;
                }
                stdoutChunks.push(chunk);
            });

            ytdlp.stderr?.on('data', (data) => {
                if (settled || terminalError) {
                    return;
                }
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                stderrBytes += chunk.length;
                if (stderrBytes > maxStderrBytes) {
                    failAndTerminate(new Error(`yt-dlp stderr exceeded ${maxStderrBytes} bytes`));
                    return;
                }
                stderrChunks.push(chunk);
            });

            signal?.addEventListener('abort', onAbort, { once: true });

            ytdlp.once('error', (error) => {
                if (ytdlp.pid === undefined) finish(error);
                else failAndTerminate(error);
            });
            ytdlp.on('close', (code) => {
                if (killTimer) {
                    clearTimeout(killTimer);
                }
                if (settled) {
                    return;
                }
                if (terminalError) {
                    finish(terminalError);
                    return;
                }
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
                    finish(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
                    return;
                }

                finish();
            });
        });
    }

    private getYtdlpRuntimeArgs(): string[] {
        const args: string[] = [];
        if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
            args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
        } else if (process.env.YTDLP_COOKIES) {
            args.push('--cookies', process.env.YTDLP_COOKIES);
        }

        const raw = process.env.YTDLP_EXTRA_ARGS?.trim();
        if (!raw) return args;
        if (!config.audio.allowUnsafeYtdlpExtraArgs) {
            if (!this.warnedUnsafeYtdlpExtraArgsIgnored) {
                this.warnedUnsafeYtdlpExtraArgsIgnored = true;
                console.warn('YTDLP_EXTRA_ARGS ignored. Set YTDLP_ALLOW_UNSAFE_EXTRA_ARGS=true only in a trusted environment.');
            }
            return args;
        }

        const matches = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
        args.push(...matches.map((arg) => arg.replace(/^['"]|['"]$/g, '')));
        return args;
    }

    private normalizeVideoId(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null;
        }

        const extracted = this.extractVideoId(value);
        if (extracted) {
            return extracted;
        }

        return /^[\w-]{11}$/.test(value) ? value : null;
    }

    private coerceDurationSeconds(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.floor(value));
        }

        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed)) {
                return Math.max(0, Math.floor(parsed));
            }
        }

        return 0;
    }

    private coerceViewCount(value: unknown): number | undefined {
        const parsed = typeof value === 'number'
            ? value
            : typeof value === 'string'
                ? Number.parseInt(value, 10)
                : NaN;

        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    }

    private formatDurationFromSeconds(totalSeconds: number): string {
        const safeSeconds = Math.max(0, Math.floor(totalSeconds));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }

        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    private getYtdlpThumbnail(entry: any): string {
        if (typeof entry?.thumbnail === 'string') {
            return entry.thumbnail;
        }

        if (Array.isArray(entry?.thumbnails) && entry.thumbnails.length > 0) {
            const thumbnail = entry.thumbnails
                .filter((candidate: any) => typeof candidate?.url === 'string')
                .sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0];
            return thumbnail?.url ?? '';
        }

        return '';
    }

    private parseDurationToSeconds(duration: string): number {
        if (duration.includes(':')) {
            const parts = duration.split(':').map(Number);
            if (parts.some((part) => Number.isNaN(part))) {
                return 0;
            }
            if (parts.length === 3) {
                return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            if (parts.length === 2) {
                return parts[0] * 60 + parts[1];
            }
        }

        const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!match) {
            return 0;
        }

        const hours = Number.parseInt(match[1] || '0', 10);
        const minutes = Number.parseInt(match[2] || '0', 10);
        const seconds = Number.parseInt(match[3] || '0', 10);

        return hours * 3600 + minutes * 60 + seconds;
    }

    private decodeHtmlEntities(text: string): string {
        const entities: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'",
            '&apos;': "'",
            '&#x27;': "'",
            '&#x2F;': '/',
            '&#x60;': '`',
            '&#x3D;': '=',
        };

        return text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
    }

    private normalizeSearchText(text: string): string {
        return text
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9#]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
        const response = await httpRequest({
            url,
            method: 'GET',
            headers: {
                'User-Agent': 'LolBot/1.0',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                Accept: 'application/json',
            },
            allowedDomains: this.allowedDomains,
            timeoutMs: this.requestTimeoutMs,
            maxBytes: this.maxBytes,
            responseType: 'text',
            signal,
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            const body = String(response.body).replace(/\s+/g, ' ').trim().slice(0, 300);
            throw new Error(`YouTube Data API request failed with status ${response.statusCode}: ${body}`);
        }

        return JSON.parse(response.body as string) as T;
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}

export const youtubeService = new YouTubeService();
