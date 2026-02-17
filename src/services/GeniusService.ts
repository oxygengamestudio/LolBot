import https from 'https';
import zlib from 'zlib';
import { URLSearchParams } from 'url';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import { assertHttpsUrlAllowed, sanitizeUrlForLogs } from '../utils/networkSafety.js';
import type { IncomingMessage } from 'http';

const log = logger.createModuleLogger('GeniusService');

interface GeniusSong {
    id: number;
    title: string;
    fullTitle: string;
    url: string;
    artist: string;
    lyricsState?: string;
}

export interface LyricsResult {
    title: string;
    fullTitle: string;
    artist: string;
    url: string;
    lyrics: string;
}

class GeniusService {
    private accessToken: string | null = null;
    private tokenExpiresAt = 0;
    private tokenPromise: Promise<string | null> | null = null;
    private readonly requestTimeoutMs = 15_000;
    private readonly maxRedirects = 5;
    private readonly allowedDomains = ['genius.com'] as const;

    async getLyrics(query: string): Promise<LyricsResult | null> {
        if (!query || query.trim().length === 0) {
            log.warn('Empty query provided to getLyrics');
            return null;
        }

        const queries = this.buildQueries(query);
        if (queries.length === 0) {
            log.warn('No valid queries after normalization');
            return null;
        }

        let fallbackTranslation: LyricsResult | null = null;

        for (const q of queries) {
            const songs = await this.searchSongs(q);
            if (songs.length === 0) {
                continue;
            }

            const originalSongs = songs.filter((song) => !this.isTranslationCandidate(song)).slice(0, 5);
            const translatedSongs = songs.filter((song) => this.isTranslationCandidate(song)).slice(0, 3);

            const originalResult = await this.trySongsForLyrics(originalSongs, true);
            if (originalResult) {
                return originalResult;
            }

            if (!fallbackTranslation) {
                fallbackTranslation = await this.trySongsForLyrics(translatedSongs, false);
            }
        }

        return fallbackTranslation;
    }

    private async trySongsForLyrics(songs: GeniusSong[], strictQuality: boolean): Promise<LyricsResult | null> {
        for (const song of songs) {
            try {
                const html = await this.fetchText(song.url);
                const lyrics = this.extractLyrics(html);
                if (!lyrics) {
                    continue;
                }

                if (!this.isLyricsQualityAcceptable(song, lyrics, strictQuality)) {
                    continue;
                }

                return {
                    title: song.title,
                    fullTitle: song.fullTitle,
                    artist: song.artist,
                    url: song.url,
                    lyrics,
                };
            } catch (error) {
                log.trace(`Impossible de recuperer les paroles pour ${song.fullTitle}`, error);
            }
        }

        return null;
    }

    private async searchSongs(query: string): Promise<GeniusSong[]> {
        if (!query || query.trim().length === 0) {
            log.debug('searchSongs: empty query, skipping');
            return [];
        }

        const token = await this.getAccessToken();
        if (token) {
            try {
                const params = new URLSearchParams({ q: query });
                const url = `https://api.genius.com/search?${params.toString()}`;
                const data = await this.fetchJson(url, token);

                const hits = data?.response?.hits ?? [];
                const results = Array.isArray(hits)
                    ? hits.filter((item: any) => item.type === 'song').map((item: any) => item.result)
                    : [];
                const ranked = this.rankCandidates(query, results);
                if (ranked.length > 0) {
                    return ranked;
                }
            } catch (error) {
                log.warn('Genius API search failed, trying public search.', error);
            }
        } else {
            log.warn('Genius token unavailable, trying public search.');
        }

        return this.searchSongsPublic(query);
    }

    private async searchSongsPublic(query: string): Promise<GeniusSong[]> {
        if (!query || query.trim().length === 0) {
            log.debug('searchSongsPublic: empty query, skipping');
            return [];
        }

        const params = new URLSearchParams({ q: query });
        const url = `https://genius.com/api/search/multi?${params.toString()}`;
        const data = await this.fetchJsonPublic(url);

        const sections = data?.response?.sections ?? [];
        const results: any[] = [];

        for (const section of sections) {
            if (!section || !Array.isArray(section.hits)) {
                continue;
            }
            if (section.type === 'song' || section.type === 'top_hit') {
                for (const hit of section.hits) {
                    if (hit?.result) {
                        results.push(hit.result);
                    }
                }
            }
        }

        if (results.length === 0) {
            const lyricSection = sections.find((section: any) => section.type === 'lyric');
            const lyricHits = lyricSection?.hits ?? [];
            if (Array.isArray(lyricHits)) {
                results.push(...lyricHits.map((hit: any) => hit?.result).filter(Boolean));
            }
        }

        return this.rankCandidates(query, results);
    }

    private rankCandidates(query: string, results: any[]): GeniusSong[] {
        const candidates = results
            .map((result) => this.coerceSong(result))
            .filter((candidate): candidate is GeniusSong => Boolean(candidate));

        if (candidates.length === 0) {
            return [];
        }

        const normalizedQuery = this.normalizeSearchText(query);
        const tokens = this.tokenizeQuery(normalizedQuery);

        const scored = candidates
            .map((candidate) => ({
                candidate,
                score: this.scoreCandidate(candidate, normalizedQuery, tokens),
            }))
            .filter((entry) => entry.score >= 4);

        if (scored.length === 0) {
            return [];
        }

        scored.sort((a, b) => b.score - a.score);
        const deduped = new Map<number, GeniusSong>();
        for (const entry of scored) {
            if (!deduped.has(entry.candidate.id)) {
                deduped.set(entry.candidate.id, entry.candidate);
            }
        }

        return Array.from(deduped.values());
    }

    private coerceSong(result: any): GeniusSong | null {
        if (!result || !result.id || !result.url || !result.title) {
            return null;
        }

        const title = this.decodeHtmlEntities(String(result.title));
        const fullTitle = this.decodeHtmlEntities(String(result.full_title ?? result.title));
        const artist = this.decodeHtmlEntities(String(result.primary_artist?.name ?? 'Unknown'));

        return {
            id: result.id,
            title,
            fullTitle,
            url: result.url,
            artist,
            lyricsState: result.lyrics_state,
        };
    }

    private buildQueries(query: string): string[] {
        const cleaned = this.normalizeQuery(query);
        const stripped = this.stripBrackets(query);
        const strippedClean = this.normalizeQuery(stripped);

        const unique = new Set<string>();
        const add = (value: string) => {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                unique.add(trimmed);
            }
        };

        const addNormalized = (value: string) => {
            add(value);
            add(this.stripBrackets(value));
            add(this.normalizeQuery(value));
            add(this.normalizeQuery(this.stripBrackets(value)));
        };

        [query, stripped, cleaned, strippedClean].forEach(add);

        const splitVariants = this.buildSplitVariants(query);
        for (const variant of splitVariants) {
            addNormalized(variant);
        }

        return Array.from(unique);
    }

    private buildSplitVariants(text: string): string[] {
        const variants = new Set<string>();
        const addPair = (left: string, right: string) => {
            const a = left.trim();
            const b = right.trim();
            if (!a || !b) return;
            variants.add(`${a} ${b}`);
            variants.add(`${b} ${a}`);
            variants.add(a);
            variants.add(b);
        };

        const splitBy = (value: string) => {
            const parts = value.split(/\s[-–—|•:]\s/);
            if (parts.length >= 2) {
                const left = parts[0];
                const right = parts.slice(1).join(' ');
                addPair(left, right);
            }
        };

        splitBy(text);

        const byParts = text.split(/\s+by\s+/i);
        if (byParts.length === 2) {
            addPair(byParts[0], byParts[1]);
        }

        return Array.from(variants);
    }

    private stripBrackets(text: string): string {
        return text.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private normalizeQuery(text: string): string {
        const lowered = text.toLowerCase();
        const withoutTags = lowered
            .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*/g, ' ')
            .replace(/\b(official|officiel|officielle|lyrics|lyric|audio|video|mv|m\/v|clip|visualizer|live|remix|remastered|hd|hq|4k|8k|ost|theme|soundtrack|feat|ft|featuring|version|edit|prod|produced)\b/g, ' ')
            .replace(/[&]/g, ' ')
            .replace(/[-|]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return withoutTags;
    }

    private normalizeSearchText(text: string): string {
        return text
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private tokenizeQuery(normalizedQuery: string): string[] {
        if (!normalizedQuery) return [];
        return normalizedQuery.split(' ').filter((token) => token.length > 0);
    }

    private scoreCandidate(candidate: GeniusSong, normalizedQuery: string, tokens: string[]): number {
        const urlSlug = this.getSongUrlSlug(candidate.url);
        const haystack = this.normalizeSearchText(
            `${candidate.title} ${candidate.fullTitle} ${candidate.artist} ${urlSlug}`
        );
        let score = 0;

        if (normalizedQuery && haystack.includes(normalizedQuery)) {
            score += 20;
        }

        let matchedTokens = 0;
        for (const token of tokens) {
            if (token.length >= 2 && haystack.includes(token)) {
                score += 4;
                matchedTokens++;
            }
        }

        const significantTokens = tokens.filter((t) => t.length >= 2);
        if (significantTokens.length > 0 && matchedTokens === 0) {
            return -100;
        }

        if (candidate.lyricsState === 'complete') {
            score += 8;
        } else if (candidate.lyricsState === 'partial') {
            score -= 2;
        } else if (candidate.lyricsState === 'unreleased') {
            score -= 6;
        }

        if (this.isTranslationCandidate(candidate)) {
            score -= 80;
        }

        log.trace(`Score ${score} pour: ${candidate.fullTitle}`);
        return score;
    }

    private isTranslationCandidate(candidate: GeniusSong): boolean {
        return (
            this.hasTranslationMarker(candidate.title) ||
            this.hasTranslationMarker(candidate.fullTitle) ||
            this.hasTranslationMarker(candidate.artist) ||
            this.hasTranslationMarker(this.getSongUrlSlug(candidate.url))
        );
    }

    private hasTranslationMarker(text: string): boolean {
        const normalized = this.normalizeSearchText(text);
        const markers = [
            'translation',
            'translations',
            'translated',
            'traduction',
            'traductions',
            'traduccion',
            'traducciones',
            'traduzione',
            'traduzioni',
            'traducao',
            'ubersetzung',
            'ubersetzungen',
            'ceviri',
            'cevirisi',
            'ceviriler',
            'turkce',
            'turkceceviri',
            'turkceceviriler',
            'romanized',
            'romaji',
            'phonetic',
            'transliteration',
        ];

        return markers.some((marker) => normalized.includes(marker));
    }

    private getSongUrlSlug(url: string): string {
        try {
            const parsed = new URL(url);
            return parsed.pathname;
        } catch {
            return url;
        }
    }

    private isLyricsQualityAcceptable(song: GeniusSong, lyrics: string, strictQuality: boolean): boolean {
        const lines = lyrics
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        const charCount = lyrics.replace(/\s+/g, ' ').trim().length;
        const uniqueLines = new Set(lines.map((line) => this.normalizeSearchText(line)));
        const isShort = lines.length < 8 || charCount < 220;
        const lowVariety = lines.length >= 6 && uniqueLines.size <= Math.max(3, Math.floor(lines.length * 0.35));
        const isPartial = song.lyricsState === 'partial';

        if (isShort || lowVariety) {
            return false;
        }

        if (isPartial && strictQuality && (lines.length < 18 || charCount < 700)) {
            return false;
        }

        if (strictQuality && (lines.length < 10 || charCount < 320)) {
            return false;
        }

        return true;
    }

    private async getAccessToken(): Promise<string | null> {
        if (config.genius.accessToken) {
            return config.genius.accessToken;
        }

        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken;
        }

        if (this.tokenPromise) {
            return this.tokenPromise;
        }

        if (!config.genius.clientId || !config.genius.clientSecret) {
            return null;
        }

        this.tokenPromise = this.requestToken(config.genius.clientId, config.genius.clientSecret)
            .finally(() => {
                this.tokenPromise = null;
            });

        return this.tokenPromise;
    }

    private async requestToken(clientId: string, clientSecret: string): Promise<string | null> {
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        }).toString();

        try {
            const response = await this.requestRaw('https://api.genius.com/oauth/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body).toString(),
                },
                body,
            });

            if (response.statusCode >= 400) {
                log.debug(`Genius token request failed with HTTP ${response.statusCode}`);
                return null;
            }

            const json = JSON.parse(response.body);
            const token = json.access_token as string | undefined;
            const expiresIn = Number(json.expires_in ?? 0);
            if (!token) {
                return null;
            }

            this.accessToken = token;
            this.tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 0) * 1000;
            return token;
        } catch (error) {
            log.error('Genius token request failed', error);
            return null;
        }
    }

    private async fetchJson(url: string, token: string): Promise<any> {
        const response = await this.requestRaw(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'LolBot/1.0',
                'Accept-Encoding': 'gzip, deflate, br',
            },
        });

        if (response.statusCode >= 400) {
            log.debug(`Genius API (auth) returned ${response.statusCode} for: ${url}`);
            return { response: { hits: [] } };
        }

        try {
            return JSON.parse(response.body);
        } catch {
            throw new Error('Invalid JSON response');
        }
    }

    private async fetchJsonPublic(url: string): Promise<any> {
        const response = await this.requestRaw(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'LolBot/1.0',
                'Accept-Encoding': 'gzip, deflate, br',
            },
        });

        if (response.statusCode >= 400) {
            log.debug(`Genius API returned ${response.statusCode} for query: ${url}`);
            return { response: { sections: [] } };
        }

        try {
            return JSON.parse(response.body);
        } catch {
            throw new Error('Invalid JSON response');
        }
    }

    private async fetchText(url: string): Promise<string> {
        const response = await this.requestRaw(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
            },
        });

        if (response.statusCode >= 400) {
            throw new Error(`Genius page error: ${response.statusCode}`);
        }

        return response.body;
    }

    private requestRaw(
        url: string,
        options: {
            method: 'GET' | 'POST';
            headers?: Record<string, string>;
            body?: string;
        },
        redirectCount: number = 0
    ): Promise<{ statusCode: number; body: string }> {
        return new Promise((resolve, reject) => {
            const safeUrl = sanitizeUrlForLogs(url);

            if (redirectCount > this.maxRedirects) {
                reject(new Error(`Too many redirects for ${safeUrl}`));
                return;
            }

            const urlObj = assertHttpsUrlAllowed(url, this.allowedDomains);
            const req = https.request(
                {
                    method: options.method,
                    hostname: urlObj.hostname,
                    port: urlObj.port ? Number(urlObj.port) : undefined,
                    path: urlObj.pathname + urlObj.search,
                    headers: options.headers,
                },
                (res) => {
                    const statusCode = res.statusCode ?? 0;

                    if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                        const redirectUrl = new URL(res.headers.location, urlObj).toString();
                        res.resume();

                        const shouldSwitchToGet =
                            statusCode === 303 || ((statusCode === 301 || statusCode === 302) && options.method === 'POST');
                        const nextMethod = shouldSwitchToGet ? 'GET' : options.method;
                        const nextHeaders = { ...(options.headers ?? {}) };
                        const nextBody = shouldSwitchToGet ? undefined : options.body;

                        if (shouldSwitchToGet) {
                            delete nextHeaders['Content-Length'];
                            delete nextHeaders['Content-Type'];
                        }

                        this.requestRaw(
                            redirectUrl,
                            { method: nextMethod, headers: nextHeaders, body: nextBody },
                            redirectCount + 1
                        )
                            .then(resolve)
                            .catch(reject);
                        return;
                    }

                    const stream = this.getDecodedStream(res);
                    let data = '';

                    stream.on('data', (chunk) => {
                        data += chunk.toString();
                    });
                    stream.on('end', () => {
                        resolve({ statusCode, body: data });
                    });
                    stream.on('error', (error) => {
                        reject(error);
                    });
                }
            );

            req.setTimeout(this.requestTimeoutMs, () => {
                req.destroy(new Error(`Request timeout after ${this.requestTimeoutMs}ms for ${safeUrl}`));
            });
            req.on('error', reject);

            if (options.body) {
                req.write(options.body);
            }

            req.end();
        });
    }

    private getDecodedStream(res: IncomingMessage): NodeJS.ReadableStream {
        const encoding = (res.headers['content-encoding'] || '').toString().toLowerCase();
        if (encoding.includes('br')) {
            return res.pipe(zlib.createBrotliDecompress());
        }
        if (encoding.includes('gzip')) {
            return res.pipe(zlib.createGunzip());
        }
        if (encoding.includes('deflate')) {
            return res.pipe(zlib.createInflate());
        }
        return res;
    }

    private extractLyrics(html: string): string | null {
        const modernContainers = this.extractDivContainerContents(
            html,
            /<div\b[^>]*data-lyrics-container="true"[^>]*>/gi
        );
        const legacyContainers = modernContainers.length > 0
            ? modernContainers
            : this.extractDivContainerContents(
                html,
                /<div\b[^>]*class="[^"]*Lyrics__Container[^"]*"[^>]*>/gi
            );

        let raw = legacyContainers.join('\n');
        if (!raw) {
            const legacyMatch = html.match(/<div class="lyrics">([\s\S]*?)<\/div>/);
            if (legacyMatch) {
                raw = legacyMatch[1];
            }
        }

        if (!raw) {
            return null;
        }

        const withBreaks = raw
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
        const stripped = withBreaks.replace(/<[^>]+>/g, '');
        const decoded = this.decodeHtmlEntities(stripped);
        const cleaned = decoded.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
        const sanitized = this.cleanupLyrics(cleaned);
        return sanitized || null;
    }

    private extractDivContainerContents(html: string, openTagRegex: RegExp): string[] {
        const source = openTagRegex.source;
        const flags = openTagRegex.flags.includes('g') ? openTagRegex.flags : `${openTagRegex.flags}g`;
        const regex = new RegExp(source, flags);

        const containers: string[] = [];
        let match = regex.exec(html);
        while (match) {
            const openTagStart = match.index;
            const openTagEnd = html.indexOf('>', openTagStart);
            if (openTagEnd < 0) {
                break;
            }

            const contentStart = openTagEnd + 1;
            const contentEnd = this.findMatchingDivClose(html, contentStart);
            if (contentEnd > contentStart) {
                containers.push(html.slice(contentStart, contentEnd));
                regex.lastIndex = contentEnd + 6; // </div>
            } else {
                regex.lastIndex = contentStart;
            }

            match = regex.exec(html);
        }

        return containers;
    }

    private findMatchingDivClose(html: string, fromIndex: number): number {
        const tagRegex = /<\/?div\b[^>]*>/gi;
        tagRegex.lastIndex = fromIndex;
        let depth = 1;
        let match = tagRegex.exec(html);

        while (match) {
            const tag = match[0];
            if (tag.startsWith('</')) {
                depth -= 1;
                if (depth === 0) {
                    return match.index;
                }
            } else {
                depth += 1;
            }
            match = tagRegex.exec(html);
        }

        return -1;
    }

    private cleanupLyrics(text: string): string {
        const lines = text.split(/\r?\n/);
        const filtered = lines.filter((line) => {
            const trimmed = line.trim();
            if (!trimmed) return true;

            if (this.isLanguageNavigationLine(trimmed)) return false;
            if (/contributors?/i.test(trimmed)) return false;
            if (/you might also like/i.test(trimmed)) return false;
            if (/^embed$/i.test(trimmed)) return false;
            if (/^translations?/i.test(trimmed)) return false;
            if (/^genius/i.test(trimmed) && /lyrics/i.test(trimmed)) return false;
            if (/lyrics$/i.test(trimmed) && /genius/i.test(trimmed)) return false;
            if (/open on genius/i.test(trimmed)) return false;
            if (/ouvrir sur genius/i.test(trimmed)) return false;
            if (/lyrics$/i.test(trimmed)) return false;
            if (/^paroles de/i.test(trimmed)) return false;
            if (trimmed.length <= 80 && this.hasTranslationMarker(trimmed)) return false;

            return true;
        });

        const trimmedIntro = this.trimIntroNoise(filtered);
        return trimmedIntro.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    private trimIntroNoise(lines: string[]): string[] {
        const firstSectionIndex = lines.findIndex((line) =>
            /^\[(couplet|verse|refrain|chorus|pont|bridge|intro|outro|pre-chorus|post-chorus|hook)/i.test(line.trim())
        );

        if (firstSectionIndex > 0) {
            return lines.slice(firstSectionIndex);
        }

        return lines;
    }

    private isLanguageNavigationLine(line: string): boolean {
        if (/^(العربية|русский|日本語|한국어|中文|繁體中文|简体中文)$/iu.test(line.trim())) {
            return true;
        }

        const normalized = this.normalizeSearchText(line);
        if (!normalized) {
            return false;
        }

        const languageTokens = new Set([
            'english',
            'francais',
            'french',
            'espanol',
            'spanish',
            'deutsch',
            'german',
            'magyar',
            'italiano',
            'portugues',
            'portuguese',
            'arabic',
            'arabe',
            'turkce',
            'turkish',
            'russian',
            'japanese',
            'korean',
            'chinese',
            'zhongwen',
            'hindi',
            'polski',
            'dutch',
            'nederlands',
        ]);

        const tokens = normalized.split(' ').filter(Boolean);
        if (tokens.length === 0 || tokens.length > 4) {
            return false;
        }

        return tokens.every((token) => languageTokens.has(token));
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
            '&nbsp;': ' ',
        };

        const namedDecoded = text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
        return namedDecoded
            .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
                const code = Number.parseInt(hex, 16);
                if (Number.isNaN(code)) return _match;
                return String.fromCodePoint(code);
            })
            .replace(/&#([0-9]+);/g, (_match, dec) => {
                const code = Number.parseInt(dec, 10);
                if (Number.isNaN(code)) return _match;
                return String.fromCodePoint(code);
            });
    }
}

export const geniusService = new GeniusService();
