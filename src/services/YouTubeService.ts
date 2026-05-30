import { config } from '../config.js';
import type { PlaylistInfo, SearchResult, Track, YouTubeVideoInfo } from '../types/index.js';
import { httpRequest } from '../utils/httpClient.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

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

export interface RankedSearchResult extends SearchResult {
    score: number;
}

interface YouTubeThumbnailSet {
    default?: { url?: string };
    high?: { url?: string };
}

interface SearchApiItem {
    id?: { videoId?: string };
    snippet?: {
        title?: string;
        channelTitle?: string;
        channelId?: string;
        thumbnails?: YouTubeThumbnailSet;
    };
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

export class YouTubeService {
    private readonly apiKey = config.youtube.apiKey;
    private readonly requestTimeoutMs = 15_000;
    private readonly maxBytes = 2 * 1024 * 1024;
    private readonly allowedDomains = ['googleapis.com', 'youtube.com', 'youtube-nocookie.com', 'youtu.be'] as const;
    private readonly shortsMarkerPattern = /(?:^|[^a-z0-9])(?:shorts|#shorts)(?:$|[^a-z0-9])/i;
    private youtubeApiBackoffUntil = 0;

    async search(query: string, maxResults = 10): Promise<SearchResult[]> {
        const ranked = await this.searchWithRanking(query, maxResults);
        return ranked.map((result) => {
            const { score: _score, ...searchResult } = result;
            return searchResult;
        });
    }

    async searchWithRanking(query: string, maxResults = 10): Promise<RankedSearchResult[]> {
        const normalizedQuery = this.normalizeSearchInput(query);
        const rawResults = await this.searchRawVariants(normalizedQuery, maxResults);
        let ranked = this.rankSearchResults(normalizedQuery, rawResults)
            .sort((a, b) => (b.score - a.score) || ((b.viewCount ?? 0) - (a.viewCount ?? 0)))
            .filter((result) => result.score >= 0)
            .slice(0, maxResults);

        if (this.apiKey && ranked.length < Math.min(3, maxResults)) {
            const fallbackResults = await this.searchRawVariants(normalizedQuery, maxResults, true);
            if (fallbackResults.length > 0) {
                const unique = new Map<string, SearchResult>();
                for (const result of [...rawResults, ...fallbackResults]) {
                    if (!unique.has(result.id)) {
                        unique.set(result.id, result);
                    }
                }

                ranked = this.rankSearchResults(normalizedQuery, Array.from(unique.values()))
                    .sort((a, b) => (b.score - a.score) || ((b.viewCount ?? 0) - (a.viewCount ?? 0)))
                    .filter((result) => result.score >= 0)
                    .slice(0, maxResults);
            }
        }

        return ranked;
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

    private async searchRaw(query: string, maxResults = 10, forceYtdlp = false): Promise<SearchResult[]> {
        if (!this.apiKey || forceYtdlp || this.isYouTubeApiBackedOff()) {
            return this.searchWithYtdlp(query, Math.min(Math.max(maxResults * 3, maxResults), 25));
        }

        try {
            return await this.searchWithGoogle(query, maxResults);
        } catch (error) {
            if (this.isQuotaOrAuthError(error)) {
                this.youtubeApiBackoffUntil = Date.now() + 10 * 60 * 1000;
            }
            console.warn('YouTube Data API search failed, falling back to yt-dlp:', this.formatError(error));
            return this.searchWithYtdlp(query, Math.min(Math.max(maxResults * 3, maxResults), 25));
        }
    }

    private async searchRawVariants(query: string, maxResults = 10, forceYtdlp = false): Promise<SearchResult[]> {
        const variants = this.buildSearchVariants(query);
        const unique = new Map<string, SearchResult>();

        for (const variant of variants) {
            const results = await this.searchRaw(variant, maxResults, forceYtdlp).catch(() => [] as SearchResult[]);
            for (const result of results) {
                if (!unique.has(result.id)) {
                    unique.set(result.id, result);
                }
            }
            if (unique.size >= Math.max(maxResults * 2, 12)) {
                break;
            }
        }

        return Array.from(unique.values());
    }

    private buildSearchVariants(query: string): string[] {
        const trimmed = query.trim();
        if (!trimmed) {
            return [trimmed];
        }

        const inflectedQueries = this.buildInflectedSearchVariants(trimmed);
        const variants: string[] = [];
        variants.push(trimmed, `"${trimmed}"`);
        for (const inflectedQuery of inflectedQueries) {
            variants.push(inflectedQuery, `"${inflectedQuery}"`);
        }
        variants.push(
            `${trimmed} official music video`,
            `${trimmed} official lyric video`,
            `${trimmed} vevo`,
        );

        return Array.from(new Set(variants));
    }

    private async searchWithGoogle(query: string, maxResults = 10): Promise<SearchResult[]> {
        const effectiveMaxResults = Math.max(1, Math.min(maxResults, 25));
        const expandedMaxResults = Math.max(effectiveMaxResults, Math.min(effectiveMaxResults * 3, 25));
        const params = new URLSearchParams({
            part: 'snippet',
            q: this.buildSearchQuery(query),
            type: 'video',
            maxResults: expandedMaxResults.toString(),
            key: this.apiKey!,
            videoCategoryId: '10',
        });

        const searchUrl = `${YOUTUBE_API_BASE}/search?${params.toString()}`;
        const searchData = await this.fetchJson<YouTubeListResponse<SearchApiItem>>(searchUrl);
        const items = searchData.items ?? [];
        if (items.length === 0) {
            return [];
        }

        const videoIds = items
            .map((item) => item.id?.videoId)
            .filter((value): value is string => Boolean(value))
            .join(',');
        if (!videoIds) {
            return [];
        }

        const detailsParams = new URLSearchParams({
            part: 'contentDetails,snippet,statistics',
            id: videoIds,
            key: this.apiKey!,
        });
        const detailsUrl = `${YOUTUBE_API_BASE}/videos?${detailsParams.toString()}`;
        const detailsData = await this.fetchJson<YouTubeListResponse<VideoApiItem>>(detailsUrl);

        return (detailsData.items ?? [])
            .filter((item): item is VideoApiItem & { id: string; snippet: NonNullable<VideoApiItem['snippet']>; contentDetails: NonNullable<VideoApiItem['contentDetails']> } =>
                Boolean(item.id && item.snippet && item.contentDetails?.duration)
            )
            .filter((item) => !this.isLikelyShortVideo(item))
            .map((item) => ({
                id: item.id,
                title: this.decodeHtmlEntities(item.snippet.title ?? 'Unknown title'),
                duration: this.parseDuration(item.contentDetails.duration ?? 'PT0S'),
                durationSeconds: this.parseDurationToSeconds(item.contentDetails.duration ?? 'PT0S'),
                thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
                channelTitle: item.snippet.channelTitle ?? 'Unknown channel',
                channelId: item.snippet.channelId,
                viewCount: this.coerceViewCount(item.statistics?.viewCount),
            }))
            .slice(0, expandedMaxResults);
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

    async getVideoInfo(videoId: string): Promise<YouTubeVideoInfo | null> {
        if (!this.apiKey) {
            return this.getVideoInfoWithYtdlp(videoId);
        }

        try {
            return await this.getVideoInfoWithGoogle(videoId);
        } catch (error) {
            console.warn('YouTube Data API video lookup failed, falling back to yt-dlp:', this.formatError(error));
            return this.getVideoInfoWithYtdlp(videoId);
        }
    }

    private async getVideoInfoWithGoogle(videoId: string): Promise<YouTubeVideoInfo | null> {
        const params = new URLSearchParams({
            part: 'snippet,contentDetails',
            id: videoId,
            key: this.apiKey!,
        });

        const url = `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
        const data = await this.fetchJson<YouTubeListResponse<VideoApiItem>>(url);
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

    async getPlaylistTracks(playlistId: string, requestedBy: string, requestedById: string): Promise<PlaylistInfo | null> {
        if (!this.apiKey) {
            return this.getPlaylistTracksWithYtdlp(playlistId, requestedBy, requestedById);
        }

        try {
            return await this.getPlaylistTracksWithGoogle(playlistId, requestedBy, requestedById);
        } catch (error) {
            console.warn('YouTube Data API playlist lookup failed, falling back to yt-dlp:', this.formatError(error));
            return this.getPlaylistTracksWithYtdlp(playlistId, requestedBy, requestedById);
        }
    }

    private async getPlaylistTracksWithGoogle(
        playlistId: string,
        requestedBy: string,
        requestedById: string
    ): Promise<PlaylistInfo | null> {
        const playlistParams = new URLSearchParams({
            part: 'snippet',
            id: playlistId,
            key: this.apiKey!,
        });
        const playlistUrl = `${YOUTUBE_API_BASE}/playlists?${playlistParams.toString()}`;
        const playlistData = await this.fetchJson<YouTubeListResponse<{ snippet?: { title?: string } }>>(playlistUrl);
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
        const itemsData = await this.fetchJson<YouTubeListResponse<PlaylistItemApi>>(itemsUrl);
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
        const detailsData = await this.fetchJson<YouTubeListResponse<VideoApiItem>>(detailsUrl);
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
                return {
                    id: videoId,
                    title: this.decodeHtmlEntities(item.snippet.title ?? 'Unknown title'),
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    duration: durationMap.get(videoId) ?? 0,
                    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
                    sourceType: 'playlist',
                    requestedBy,
                    requestedById,
                };
            });

        return {
            id: playlistId,
            title: this.decodeHtmlEntities(playlist.snippet.title),
            itemCount: tracks.length,
            tracks,
        };
    }

    private async searchWithYtdlp(query: string, maxResults: number): Promise<SearchResult[]> {
        const unique = new Map<string, SearchResult>();
        for (const prefix of ['ytmsearch', 'ytsearch'] as const) {
            const results = await this.searchWithYtdlpPrefix(prefix, query, maxResults);
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

    private async searchWithYtdlpPrefix(prefix: 'ytmsearch' | 'ytsearch', query: string, maxResults: number): Promise<SearchResult[]> {
        try {
            const payload = await this.runYtdlpJson([
                '--no-warnings',
                '--skip-download',
                '--flat-playlist',
                '--dump-single-json',
                `${prefix}${Math.max(1, maxResults)}:${query}`,
            ]);

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

    private async getVideoInfoWithYtdlp(videoId: string): Promise<YouTubeVideoInfo | null> {
        try {
            const payload = await this.runYtdlpJson([
                '--no-warnings',
                '--skip-download',
                '--no-playlist',
                '--dump-single-json',
                `https://www.youtube.com/watch?v=${videoId}`,
            ]);

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
            console.warn('yt-dlp video lookup fallback failed:', this.formatError(error));
            return null;
        }
    }

    private async getPlaylistTracksWithYtdlp(
        playlistId: string,
        requestedBy: string,
        requestedById: string
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
            ]);

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

        return {
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
        };
    }

    async createTrackFromSearch(result: SearchResult, requestedBy: string, requestedById: string): Promise<Track> {
        return {
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
        };
    }

    async createTrackFromUrl(url: string, requestedBy: string, requestedById: string): Promise<Track | null> {
        const videoId = this.extractVideoId(url);
        if (!videoId) {
            return null;
        }

        const info = await this.getVideoInfo(videoId);
        if (!info) {
            return null;
        }

        return {
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
            score += Math.min(170, Math.log10(viewCount + 1) * 19);
            score += Math.min(120, viewCount / 10_000_000);
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

    private isYouTubeApiBackedOff(): boolean {
        return Date.now() < this.youtubeApiBackoffUntil;
    }

    private isQuotaOrAuthError(error: unknown): boolean {
        const message = this.formatError(error).toLowerCase();
        return message.includes('http 403') || message.includes('http 429') || message.includes('quota');
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

    private buildSearchQuery(query: string): string {
        const trimmed = query.trim();
        if (!trimmed) {
            return trimmed;
        }

        return `${trimmed} -shorts -#shorts`;
    }

    private isLikelyShortVideo(item: VideoApiItem): boolean {
        const title = this.decodeHtmlEntities(item.snippet?.title ?? '');
        const channelTitle = this.decodeHtmlEntities(item.snippet?.channelTitle ?? '');
        const durationSeconds = this.parseDurationToSeconds(item.contentDetails?.duration ?? 'PT0S');

        if (this.hasShortsMarker(title) || this.hasShortsMarker(channelTitle)) {
            return true;
        }

        // Shorts results often arrive with explicit markers removed inconsistently;
        // keep obvious micro-clips out of music search/autocomplete.
        if (durationSeconds > 0 && durationSeconds <= 65 && this.looksLikeVerticalClipTitle(title)) {
            return true;
        }

        return false;
    }

    private hasShortsMarker(text: string): boolean {
        return this.shortsMarkerPattern.test(this.normalizeSearchText(text));
    }

    private looksLikeVerticalClipTitle(title: string): boolean {
        const normalized = this.normalizeSearchText(title);
        return /\b(short|clip|edit|meme|status)\b/i.test(normalized);
    }

    private getYtdlpPath(): string {
        const envYtdlp = process.env.YTDLP_PATH;
        if (envYtdlp) {
            return envYtdlp;
        }

        const localYtdlpPath = join(config.paths.data, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        return existsSync(localYtdlpPath) ? localYtdlpPath : 'yt-dlp';
    }

    private runYtdlpJson(args: string[]): Promise<any> {
        return this.runYtdlpText(args).then((payload) => {
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

    private runYtdlpText(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const ytdlp = spawn(this.getYtdlpPath(), args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';

            ytdlp.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('error', reject);
            ytdlp.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
                    return;
                }

                resolve(stdout);
            });
        });
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

    private parseDuration(duration: string): string {
        const totalSeconds = this.parseDurationToSeconds(duration);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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

    private async fetchJson<T>(url: string): Promise<T> {
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
        });

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
