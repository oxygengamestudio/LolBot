import type { Track } from '../types/index.js';
import { httpRequest } from '../utils/httpClient.js';
import { logger } from '../utils/Logger.js';
import { sanitizeUrlForLogs } from '../utils/networkSafety.js';
import type { MediaSearchContext, UrlMediaProvider } from './providers/MediaProvider.js';
import { AsyncSemaphore, ytdlpRunner, type YtdlpRunner } from './providers/YtdlpRunner.js';

const log = logger.createModuleLogger('SoundCloud');
const SOUNDCLOUD_DOMAINS = ['soundcloud.com'] as const;
const CANONICAL_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const RESERVED_FIRST_SEGMENTS = new Set([
    'charts',
    'discover',
    'jobs',
    'pages',
    'search',
    'stream',
    'terms-of-use',
    'you',
]);
const RESERVED_TRACK_SEGMENTS = new Set([
    'albums',
    'comments',
    'likes',
    'recommended',
    'reposts',
    'sets',
    'spotlight',
    'stations',
    'tracks',
]);
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type SoundCloudUrlKind = 'track' | 'short' | 'unsupported' | 'not-soundcloud';

type YtdlpPayload = Record<string, unknown>;
type HttpRequester = typeof httpRequest;

export class SoundCloudService implements UrlMediaProvider {
    readonly provider = 'soundcloud';
    private readonly globalProviderSemaphore = new AsyncSemaphore(4);
    private readonly scopedProviderSemaphores = new Map<string, AsyncSemaphore>();

    constructor(
        private readonly runner: Pick<YtdlpRunner, 'runJson'> = ytdlpRunner,
        private readonly request: HttpRequester = httpRequest
    ) {}

    matchesUrl(url: string): boolean {
        const kind = this.classifyUrl(url);
        return kind === 'track' || kind === 'short';
    }

    isSoundCloudHostUrl(url: string): boolean {
        return this.classifyUrl(url) !== 'not-soundcloud';
    }

    classifyUrl(rawUrl: string): SoundCloudUrlKind {
        const parsed = this.parseUrl(rawUrl);
        if (!parsed) return 'not-soundcloud';

        const host = parsed.hostname.toLowerCase();
        const isSoundCloudHost = CANONICAL_HOSTS.has(host) || host === 'on.soundcloud.com';
        if (!isSoundCloudHost) return 'not-soundcloud';
        if (
            parsed.protocol !== 'https:' ||
            parsed.username ||
            parsed.password ||
            parsed.port ||
            parsed.searchParams.has('secret_token')
        ) {
            return 'unsupported';
        }

        const segments = parsed.pathname.split('/').filter(Boolean);
        if (host === 'on.soundcloud.com') {
            return segments.length === 1 && SLUG_PATTERN.test(segments[0] ?? '') ? 'short' : 'unsupported';
        }

        if (segments.length !== 2) return 'unsupported';
        const [uploader, title] = segments;
        if (!uploader || !title || !SLUG_PATTERN.test(uploader) || !SLUG_PATTERN.test(title)) {
            return 'unsupported';
        }
        if (
            RESERVED_FIRST_SEGMENTS.has(uploader.toLowerCase()) ||
            RESERVED_TRACK_SEGMENTS.has(uploader.toLowerCase()) ||
            RESERVED_TRACK_SEGMENTS.has(title.toLowerCase())
        ) {
            return 'unsupported';
        }
        return 'track';
    }

    async createTrackFromUrl(
        url: string,
        requestedBy: string,
        requestedById: string,
        context?: MediaSearchContext
    ): Promise<Track | null> {
        try {
            return await this.withProviderPermit(context, async () => {
                const kind = this.classifyUrl(url);
                if (kind !== 'track' && kind !== 'short') return null;

                const canonicalUrl = kind === 'short'
                    ? await this.resolveShortUrl(url, context?.signal)
                    : this.canonicalizeTrackUrl(url);
                if (!canonicalUrl) return null;

                const payload = await this.runner.runJson([
                    '--no-warnings',
                    '--skip-download',
                    '--no-playlist',
                    '--ies', 'soundcloud',
                    '--dump-single-json',
                    '--',
                    canonicalUrl,
                ], context?.signal);

                return this.createTrackFromPayload(payload, requestedBy, requestedById);
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            log.warn(`Piste SoundCloud indisponible: ${sanitizeUrlForLogs(url)}`, error);
            return null;
        }
    }

    private async withProviderPermit<T>(
        context: MediaSearchContext | undefined,
        operation: () => Promise<T>
    ): Promise<T> {
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
            return await operation();
        } finally {
            releaseGlobal?.();
            releaseScope?.();
            if (scoped.idle && this.scopedProviderSemaphores.get(scopeKey) === scoped) {
                this.scopedProviderSemaphores.delete(scopeKey);
            }
        }
    }

    private async resolveShortUrl(url: string, signal?: AbortSignal): Promise<string | null> {
        const response = await this.request({
            url,
            method: 'GET',
            headers: {
                'User-Agent': 'LolBot/1.0',
            },
            allowedDomains: SOUNDCLOUD_DOMAINS,
            timeoutMs: 5_000,
            maxRedirects: 3,
            maxBytes: 1,
            responseType: 'none',
            signal,
        });
        return this.canonicalizeTrackUrl(response.finalUrl);
    }

    private createTrackFromPayload(
        rawPayload: unknown,
        requestedBy: string,
        requestedById: string
    ): Track | null {
        if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;
        const payload = rawPayload as YtdlpPayload;
        if (Array.isArray(payload.entries) || String(payload._type ?? '').toLowerCase() === 'playlist') return null;

        const extractor = this.nonEmptyString(payload.extractor)?.toLowerCase() ?? null;
        const extractorKey = this.nonEmptyString(payload.extractor_key)?.toLowerCase() ?? null;
        if (
            (!extractor && !extractorKey) ||
            (extractor !== null && extractor !== 'soundcloud') ||
            (extractorKey !== null && extractorKey !== 'soundcloud')
        ) return null;

        const sourceId = this.nonEmptyString(payload.id);
        const title = this.nonEmptyString(payload.title);
        const duration = this.positiveDuration(payload.duration);
        if (!sourceId || !/^\d+$/.test(sourceId) || !title || duration === null) return null;

        const availability = String(payload.availability ?? '').toLowerCase();
        if (['private', 'needs_auth', 'subscriber_only', 'premium_only'].includes(availability)) return null;
        if (payload.is_live === true || String(payload.live_status ?? '').toLowerCase() === 'is_live') return null;

        const payloadUrl = this.nonEmptyString(payload.webpage_url);
        if (!payloadUrl) return null;
        const canonicalUrl = this.canonicalizeTrackUrl(payloadUrl);
        if (!canonicalUrl) return null;

        const uploader = this.nonEmptyString(payload.uploader)
            ?? this.nonEmptyString(payload.artist)
            ?? this.nonEmptyString(payload.creator);
        const uploaderId = this.nonEmptyString(payload.uploader_id);
        const codec = this.nonEmptyString(payload.acodec);
        const container = this.nonEmptyString(payload.ext);

        return {
            id: `soundcloud:${sourceId}`,
            provider: 'soundcloud',
            sourceId,
            canonicalUrl,
            codec: codec ?? undefined,
            container: container ?? undefined,
            isLive: false,
            title,
            url: canonicalUrl,
            duration,
            thumbnail: this.extractThumbnail(payload),
            channelTitle: uploader ?? undefined,
            channelId: uploaderId ?? undefined,
            sourceType: 'url',
            requestedBy,
            requestedById,
        };
    }

    private canonicalizeTrackUrl(rawUrl: string): string | null {
        if (this.classifyUrl(rawUrl) !== 'track') return null;
        const parsed = this.parseUrl(rawUrl)!;
        const [uploader, title] = parsed.pathname.split('/').filter(Boolean);
        return `https://soundcloud.com/${uploader}/${title}`;
    }

    private extractThumbnail(payload: YtdlpPayload): string {
        const direct = this.nonEmptyString(payload.thumbnail);
        if (direct) return direct;
        if (!Array.isArray(payload.thumbnails)) return '';

        const candidates = payload.thumbnails
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
            .map((item) => ({
                url: this.nonEmptyString(item.url),
                width: Number(item.width ?? 0),
            }))
            .filter((item): item is { url: string; width: number } => Boolean(item.url))
            .sort((a, b) => b.width - a.width);
        return candidates[0]?.url ?? '';
    }

    private positiveDuration(value: unknown): number | null {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    }

    private nonEmptyString(value: unknown): string | null {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const normalized = String(value).trim();
        return normalized.length > 0 ? normalized : null;
    }

    private parseUrl(rawUrl: string): URL | null {
        try {
            return new URL(rawUrl.trim());
        } catch {
            return null;
        }
    }
}

export const soundCloudService = new SoundCloudService();
