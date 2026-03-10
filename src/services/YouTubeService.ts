import { config } from '../config.js';
import type { PlaylistInfo, SearchResult, Track, YouTubeVideoInfo } from '../types/index.js';
import { httpRequest } from '../utils/httpClient.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

interface YouTubeThumbnailSet {
    default?: { url?: string };
    high?: { url?: string };
}

interface SearchApiItem {
    id?: { videoId?: string };
    snippet?: {
        title?: string;
        channelTitle?: string;
        thumbnails?: YouTubeThumbnailSet;
    };
}

interface VideoApiItem {
    id?: string;
    snippet?: {
        title?: string;
        channelTitle?: string;
        thumbnails?: YouTubeThumbnailSet;
    };
    contentDetails?: {
        duration?: string;
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

    async search(query: string, maxResults = 10): Promise<SearchResult[]> {
        const effectiveMaxResults = Math.max(1, Math.min(maxResults, 25));
        const expandedMaxResults = Math.max(effectiveMaxResults, Math.min(effectiveMaxResults * 3, 25));
        const params = new URLSearchParams({
            part: 'snippet',
            q: this.buildSearchQuery(query),
            type: 'video',
            maxResults: expandedMaxResults.toString(),
            key: this.apiKey,
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
            part: 'contentDetails,snippet',
            id: videoIds,
            key: this.apiKey,
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
                thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
                channelTitle: item.snippet.channelTitle ?? 'Unknown channel',
            }))
            .slice(0, effectiveMaxResults);
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
        const params = new URLSearchParams({
            part: 'snippet,contentDetails',
            id: videoId,
            key: this.apiKey,
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
        };
    }

    async getPlaylistTracks(playlistId: string, requestedBy: string, requestedById: string): Promise<PlaylistInfo | null> {
        const playlistParams = new URLSearchParams({
            part: 'snippet',
            id: playlistId,
            key: this.apiKey,
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
            key: this.apiKey,
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
            key: this.apiKey,
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

    async createTrackFromSearch(result: SearchResult, requestedBy: string, requestedById: string): Promise<Track> {
        return {
            id: result.id,
            title: result.title,
            url: `https://www.youtube.com/watch?v=${result.id}`,
            duration: this.parseDurationToSeconds(result.duration),
            thumbnail: result.thumbnail,
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
            requestedBy,
            requestedById,
        };
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
}

export const youtubeService = new YouTubeService();
