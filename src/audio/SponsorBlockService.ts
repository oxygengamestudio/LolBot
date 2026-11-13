import { BoundedTtlCache } from '../utils/BoundedTtlCache.js';
import { httpRequest } from '../utils/httpClient.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('SponsorBlock');

interface Segment {
    start: number;
    end: number;
}

interface SponsorEntry {
    segment?: [number, number];
    category?: string;
    videoDuration?: number;
}

export class SponsorBlockService {
    private readonly endpoints = [
        'https://api.sponsor.ajay.app/api/skipSegments',
        'https://sponsor.ajay.app/api/skipSegments',
    ];
    private cache = new BoundedTtlCache<string, Segment[]>(500, 30 * 60 * 1000);
    private pending = new Map<string, Promise<Segment[]>>();
    private readonly requestTimeoutMs = 10_000;

    async getSegments(videoId: string, enabled: boolean): Promise<Segment[]> {
        if (!enabled || !/^[\w-]{11}$/.test(videoId)) {
            return [];
        }

        const cached = this.cache.get(videoId);
        if (cached) return cached;
        if (this.pending.has(videoId)) return this.pending.get(videoId)!;
        if (this.pending.size >= 8) return [];
        const promise = this.fetchSegments(videoId).then(segments => {
            this.cache.set(videoId, segments);
            return segments;
        }).finally(() => this.pending.delete(videoId));
        this.pending.set(videoId, promise);
        return promise;
    }

    private async fetchSegments(videoId: string): Promise<Segment[]> {
        const categories = ['sponsor', 'music_offtopic', 'selfpromo', 'interaction', 'intro', 'outro'];
        const query = new URLSearchParams({
            videoID: videoId,
            categories: JSON.stringify(categories),
        }).toString();

        for (const endpoint of this.endpoints) {
            const url = `${endpoint}?${query}`;
            try {
                const response = await this.requestText(url);
                if (!response) {
                    continue;
                }

                const payload = JSON.parse(response) as unknown;
                if (!Array.isArray(payload)) {
                    continue;
                }

                const segments = payload
                    .map((entry): Segment | null => {
                        if (!this.isSponsorEntry(entry)) {
                            return null;
                        }

                        const segment = entry.segment;
                        if (!segment || segment.length < 2) {
                            return null;
                        }

                        const start = Number(segment[0]);
                        const end = Number(segment[1]);
                        if (start >= 0 && start < end && Number.isFinite(start) && Number.isFinite(end)) {
                            return { start, end };
                        }

                        return null;
                    })
                    .filter((segment): segment is Segment => segment !== null);

                if (segments.length > 0) {
                    log.debug(`Segments SponsorBlock récupérés pour ${videoId}: ${segments.length}`);
                }

                return segments;
            } catch (error) {
                log.warn(`SponsorBlock indisponible via ${endpoint} pour ${videoId}`, error);
            }
        }

        return [];
    }

    private isSponsorEntry(entry: unknown): entry is SponsorEntry {
        if (!entry || typeof entry !== 'object') {
            return false;
        }

        const candidate = entry as SponsorEntry;
        if (!Array.isArray(candidate.segment) || candidate.segment.length < 2) {
            return false;
        }
        if (
            typeof candidate.segment[0] !== 'number' ||
            typeof candidate.segment[1] !== 'number'
        ) {
            return false;
        }

        return true;
    }

    private async requestText(url: string): Promise<string | null> {
        const response = await httpRequest({ url, allowedDomains: ['api.sponsor.ajay.app', 'sponsor.ajay.app'],
            timeoutMs: this.requestTimeoutMs, maxBytes: 512 * 1024, maxRedirects: 1,
            headers: { 'User-Agent': 'LolBot SponsorBlockClient' } });
        return String(response.body);
    }
}

export const sponsorBlockService = new SponsorBlockService();
