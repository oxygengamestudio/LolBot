import http from 'http';
import https from 'https';
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
    private cache: Map<string, { segments: Segment[]; fetchedAt: number }> = new Map();
    private readonly cacheTtlMs = 30 * 60 * 1000;
    private readonly requestTimeoutMs = 10_000;

    async getSegments(videoId: string, enabled: boolean): Promise<Segment[]> {
        if (!enabled) {
            return [];
        }

        const cached = this.cache.get(videoId);
        if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
            return cached.segments;
        }

        const segments = await this.fetchSegments(videoId);
        this.cache.set(videoId, {
            segments,
            fetchedAt: Date.now(),
        });

        return segments;
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
                        if (start < end && Number.isFinite(start) && Number.isFinite(end)) {
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

    private requestText(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const parsed = new URL(url);
            const protocol = parsed.protocol === 'https:' ? https : http;
            const request = protocol.get(
                {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    path: `${parsed.pathname}${parsed.search}`,
                    headers: {
                        'User-Agent': 'LolBot SponsorBlockClient',
                    },
                },
                (response) => {
                    if (response.statusCode !== 200) {
                        response.resume();
                        resolve(null);
                        return;
                    }

                    let data = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => {
                        data += chunk;
                    });
                    response.on('end', () => resolve(data));
                }
            );

            request.on('error', () => resolve(null));
            request.setTimeout(this.requestTimeoutMs, () => {
                request.destroy();
                resolve(null);
            });
        });
    }
}

export const sponsorBlockService = new SponsorBlockService();
