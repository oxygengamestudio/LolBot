import { config } from '../config.js';
import type { SearchResult, Track, PlaylistInfo, YouTubeVideoInfo } from '../types/index.js';
import https from 'https';
import { assertHttpsUrlAllowed, sanitizeUrlForLogs } from '../utils/networkSafety.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeService {
    private apiKey: string;
    private readonly requestTimeoutMs = 15_000;
    private readonly maxRedirects = 5;
    private readonly allowedDomains = ['googleapis.com', 'youtube.com', 'youtube-nocookie.com', 'youtu.be'] as const;

    constructor() {
        this.apiKey = config.youtube.apiKey;
    }

    /**
     * Recherche des vidéos sur YouTube
     */
    async search(query: string, maxResults: number = 10): Promise<SearchResult[]> {
        const params = new URLSearchParams({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: maxResults.toString(),
            key: this.apiKey,
            videoCategoryId: '10', // Musique
        });

        const url = `${YOUTUBE_API_BASE}/search?${params}`;
        const searchData = await this.fetchJson(url);

        if (!searchData.items || searchData.items.length === 0) {
            return [];
        }

        // Récupérer les durées des vidéos
        const videoIds = searchData.items.map((item: any) => item.id.videoId).join(',');
        const detailsParams = new URLSearchParams({
            part: 'contentDetails,snippet',
            id: videoIds,
            key: this.apiKey,
        });

        const detailsUrl = `${YOUTUBE_API_BASE}/videos?${detailsParams}`;
        const detailsData = await this.fetchJson(detailsUrl);

        return detailsData.items.map((item: any) => ({
            id: item.id,
            title: this.decodeHtmlEntities(item.snippet.title),
            duration: this.parseDuration(item.contentDetails.duration),
            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
            channelTitle: item.snippet.channelTitle,
        }));
    }

    /**
     * Vérifie si une URL est une URL YouTube valide
     */
    isYouTubeUrl(url: string): boolean {
        const patterns = [
            /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
            /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=[\w-]+/,
            /^(https?:\/\/)?youtu\.be\/[\w-]+/,
            /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
        ];
        return patterns.some(pattern => pattern.test(url));
    }

    /**
     * Vérifie si l'URL est une playlist
     */
    isPlaylistUrl(url: string): boolean {
        return /[?&]list=[\w-]+/.test(url);
    }

    /**
     * Extrait l'ID de la vidéo depuis une URL
     */
    extractVideoId(url: string): string | null {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]+)/,
            /^([\w-]{11})$/,
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * Extrait l'ID de la playlist depuis une URL
     */
    extractPlaylistId(url: string): string | null {
        const match = url.match(/[?&]list=([\w-]+)/);
        return match ? match[1] : null;
    }

    /**
     * Récupère les informations d'une vidéo par son ID
     */
    async getVideoInfo(videoId: string): Promise<YouTubeVideoInfo | null> {
        const params = new URLSearchParams({
            part: 'snippet,contentDetails',
            id: videoId,
            key: this.apiKey,
        });

        const url = `${YOUTUBE_API_BASE}/videos?${params}`;
        const data = await this.fetchJson(url);

        if (!data.items || data.items.length === 0) {
            return null;
        }

        const item = data.items[0];
        const durationSeconds = this.parseDurationToSeconds(item.contentDetails.duration);

        return {
            id: item.id,
            title: this.decodeHtmlEntities(item.snippet.title),
            duration: durationSeconds,
            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
            audioStreamUrl: '', // Sera rempli par getAudioStreamUrl
        };
    }

    /**
     * Récupère les vidéos d'une playlist
     */
    async getPlaylistTracks(playlistId: string, requestedBy: string, requestedById: string): Promise<PlaylistInfo | null> {
        // Récupérer les infos de la playlist
        const playlistParams = new URLSearchParams({
            part: 'snippet',
            id: playlistId,
            key: this.apiKey,
        });

        const playlistUrl = `${YOUTUBE_API_BASE}/playlists?${playlistParams}`;
        const playlistData = await this.fetchJson(playlistUrl);

        if (!playlistData.items || playlistData.items.length === 0) {
            return null;
        }

        const playlistInfo = playlistData.items[0];

        // Récupérer les items de la playlist
        const itemsParams = new URLSearchParams({
            part: 'snippet',
            playlistId: playlistId,
            maxResults: config.audio.maxPlaylistTracks.toString(),
            key: this.apiKey,
        });

        const itemsUrl = `${YOUTUBE_API_BASE}/playlistItems?${itemsParams}`;
        const itemsData = await this.fetchJson(itemsUrl);

        if (!itemsData.items) {
            return null;
        }

        // Récupérer les durées de toutes les vidéos
        const videoIds = itemsData.items
            .filter((item: any) => item.snippet.resourceId?.videoId)
            .map((item: any) => item.snippet.resourceId.videoId)
            .join(',');

        const detailsParams = new URLSearchParams({
            part: 'contentDetails',
            id: videoIds,
            key: this.apiKey,
        });

        const detailsUrl = `${YOUTUBE_API_BASE}/videos?${detailsParams}`;
        const detailsData = await this.fetchJson(detailsUrl);

        const durationMap = new Map<string, number>();
        detailsData.items?.forEach((item: any) => {
            durationMap.set(item.id, this.parseDurationToSeconds(item.contentDetails.duration));
        });

        const tracks: Track[] = itemsData.items
            .filter((item: any) => item.snippet.resourceId?.videoId)
            .map((item: any) => ({
                id: item.snippet.resourceId.videoId,
                title: this.decodeHtmlEntities(item.snippet.title),
                url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
                duration: durationMap.get(item.snippet.resourceId.videoId) || 0,
                thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
                requestedBy,
                requestedById,
            }));

        return {
            id: playlistId,
            title: this.decodeHtmlEntities(playlistInfo.snippet.title),
            itemCount: tracks.length,
            tracks,
        };
    }

    /**
     * Crée un objet Track à partir d'un résultat de recherche
     */
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

    /**
     * Crée un objet Track à partir d'une URL
     */
    async createTrackFromUrl(url: string, requestedBy: string, requestedById: string): Promise<Track | null> {
        const videoId = this.extractVideoId(url);
        if (!videoId) return null;

        const info = await this.getVideoInfo(videoId);
        if (!info) return null;

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

    /**
     * Récupère l'URL du stream audio d'une vidéo YouTube
     * Cette méthode extrait directement l'URL audio depuis YouTube
     */
    async getAudioStreamUrl(videoId: string): Promise<string | null> {
        try {
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const html = await this.fetchText(watchUrl);

            // Extraire les données du player
            const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s);
            if (!playerResponseMatch) {
                // Essayer un autre pattern
                const altMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
                if (!altMatch) {
                    console.error('Impossible de trouver ytInitialPlayerResponse');
                    return null;
                }
            }

            const jsonStr = playerResponseMatch ? playerResponseMatch[1] : null;
            if (!jsonStr) return null;

            const playerResponse = JSON.parse(jsonStr);

            // Vérifier si la vidéo est disponible
            if (playerResponse.playabilityStatus?.status !== 'OK') {
                console.error('Vidéo non disponible:', playerResponse.playabilityStatus?.reason);
                return null;
            }

            // Chercher les formats audio
            const streamingData = playerResponse.streamingData;
            if (!streamingData) {
                console.error('Pas de streamingData disponible');
                return null;
            }

            // Préférer les formats adaptatifs (audio seul, meilleure qualité)
            const adaptiveFormats = streamingData.adaptiveFormats || [];
            const audioFormats = adaptiveFormats
                .filter((f: any) => f.mimeType?.startsWith('audio/'))
                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

            if (audioFormats.length > 0) {
                const bestAudio = audioFormats[0];
                // Si l'URL est directe
                if (bestAudio.url) {
                    return bestAudio.url;
                }
                // Si c'est une signature chiffrée, il faut la déchiffrer
                if (bestAudio.signatureCipher) {
                    const decodedUrl = await this.decipherSignature(bestAudio.signatureCipher, html);
                    if (decodedUrl) return decodedUrl;
                }
            }

            // Fallback sur les formats combinés
            const formats = streamingData.formats || [];
            if (formats.length > 0 && formats[0].url) {
                return formats[0].url;
            }

            return null;
        } catch (error) {
            console.error('Erreur lors de la récupération du stream audio:', error);
            return null;
        }
    }

    /**
     * Déchiffre la signature d'une URL YouTube
     */
    private async decipherSignature(signatureCipher: string, html: string): Promise<string | null> {
        try {
            const params = new URLSearchParams(signatureCipher);
            const url = params.get('url');
            const signature = params.get('s');
            const signatureParam = params.get('sp') || 'signature';

            if (!url || !signature) return null;

            // Extraire la fonction de déchiffrement depuis le JavaScript du player
            const playerJsMatch = html.match(/\/s\/player\/[\w]+\/player_ias\.vflset\/[\w_]+\/base\.js/);
            if (!playerJsMatch) {
                // Essayer de trouver une autre URL de player
                const altPlayerMatch = html.match(/"jsUrl":"([^"]+)"/);
                if (!altPlayerMatch) return null;
            }

            // Pour simplifier, on va utiliser une approche alternative
            // En cas de signature chiffrée, on utilise l'API innertube
            const decipheredSig = await this.getDecipheredSignature(signature, html);
            if (decipheredSig) {
                return `${url}&${signatureParam}=${encodeURIComponent(decipheredSig)}`;
            }

            return null;
        } catch (error) {
            console.error('Erreur lors du déchiffrement de la signature:', error);
            return null;
        }
    }

    /**
     * Utilise l'API innertube pour obtenir une URL sans signature
     */
    private async getDecipheredSignature(signature: string, html: string): Promise<string | null> {
        // Cette méthode est complexe et nécessiterait l'extraction et l'exécution
        // du code JavaScript de déchiffrement de YouTube
        // Pour une solution robuste, on utilise une approche différente
        return null;
    }

    /**
     * Méthode alternative utilisant l'API innertube de YouTube
     */
    async getAudioStreamUrlInnerTube(videoId: string): Promise<string | null> {
        try {
            const payload = {
                context: {
                    client: {
                        hl: 'fr',
                        gl: 'FR',
                        clientName: 'ANDROID',
                        clientVersion: '19.09.37',
                        androidSdkVersion: 30,
                        userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
                    },
                },
                videoId: videoId,
                playbackContext: {
                    contentPlaybackContext: {
                        html5Preference: 'HTML5_PREF_WANTS',
                    },
                },
                contentCheckOk: true,
                racyCheckOk: true,
            };

            const response = await this.fetchJsonPost(
                `https://www.youtube.com/youtubei/v1/player?key=${this.apiKey}`,
                payload
            );

            if (response.playabilityStatus?.status !== 'OK') {
                console.error('Vidéo non disponible via innertube');
                return null;
            }

            const streamingData = response.streamingData;
            if (!streamingData) return null;

            // Préférer les formats adaptatifs audio
            const adaptiveFormats = streamingData.adaptiveFormats || [];
            const audioFormats = adaptiveFormats
                .filter((f: any) => f.mimeType?.startsWith('audio/'))
                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

            if (audioFormats.length > 0 && audioFormats[0].url) {
                return audioFormats[0].url;
            }

            // Fallback sur formats combinés
            const formats = streamingData.formats || [];
            if (formats.length > 0 && formats[0].url) {
                return formats[0].url;
            }

            return null;
        } catch (error) {
            console.error('Erreur innertube:', error);
            return null;
        }
    }

    /**
     * Parse la durée ISO 8601 en chaîne lisible
     */
    private parseDuration(isoDuration: string): string {
        const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!match) return '0:00';

        const hours = parseInt(match[1] || '0');
        const minutes = parseInt(match[2] || '0');
        const seconds = parseInt(match[3] || '0');

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Parse la durée en secondes
     */
    private parseDurationToSeconds(duration: string): number {
        // Si c'est déjà au format mm:ss ou hh:mm:ss
        if (duration.includes(':')) {
            const parts = duration.split(':').map(Number);
            if (parts.length === 3) {
                return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            return parts[0] * 60 + parts[1];
        }

        // Format ISO 8601
        const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!match) return 0;

        const hours = parseInt(match[1] || '0');
        const minutes = parseInt(match[2] || '0');
        const seconds = parseInt(match[3] || '0');

        return hours * 3600 + minutes * 60 + seconds;
    }

    /**
     * Décode les entités HTML
     */
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

    /**
     * Effectue une requête HTTP GET et retourne le JSON
     */
    private async fetchJson(url: string): Promise<any> {
        const data = await this.request(
            url,
            'GET',
            {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            }
        );
        return this.parseJsonResponse(data, url);
    }

    /**
     * Effectue une requête HTTP POST et retourne le JSON
     */
    private async fetchJsonPost(url: string, body: any): Promise<any> {
        const bodyStr = JSON.stringify(body);
        const data = await this.request(
            url,
            'POST',
            {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr).toString(),
                'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            },
            bodyStr
        );
        return this.parseJsonResponse(data, url);
    }

    /**
     * Effectue une requête HTTP GET et retourne le texte
     */
    private fetchText(url: string): Promise<string> {
        return this.request(
            url,
            'GET',
            {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'identity',
            }
        );
    }

    private parseJsonResponse(data: string, url: string): any {
        try {
            return JSON.parse(data);
        } catch {
            throw new Error(`Invalid JSON response from ${sanitizeUrlForLogs(url)}`);
        }
    }

    private request(
        url: string,
        method: 'GET' | 'POST',
        headers: Record<string, string>,
        body?: string,
        redirectCount: number = 0
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const safeUrl = sanitizeUrlForLogs(url);

            if (redirectCount > this.maxRedirects) {
                reject(new Error(`Too many redirects for ${safeUrl}`));
                return;
            }

            const urlObj = assertHttpsUrlAllowed(url, this.allowedDomains);
            const options: https.RequestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port ? Number(urlObj.port) : undefined,
                path: urlObj.pathname + urlObj.search,
                method,
                headers: {
                    ...headers,
                },
            };

            const req = https.request(options, (res) => {
                const statusCode = res.statusCode ?? 0;

                if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                    const redirectUrl = new URL(res.headers.location, urlObj).toString();
                    res.resume();

                    const shouldSwitchToGet =
                        statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST');
                    const nextMethod = shouldSwitchToGet ? 'GET' : method;
                    const nextBody = shouldSwitchToGet ? undefined : body;
                    const nextHeaders = { ...headers };

                    if (shouldSwitchToGet) {
                        delete nextHeaders['Content-Length'];
                    }

                    this.request(redirectUrl, nextMethod, nextHeaders, nextBody, redirectCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode} from ${safeUrl}`));
                    return;
                }

                let data = '';
                res.setEncoding('utf8');
                res.on("data", (chunk: string) => {
                    data += chunk;
                });
                res.on("end", () => resolve(data));
            });

            req.setTimeout(this.requestTimeoutMs, () => {
                req.destroy(new Error(`Request timeout after ${this.requestTimeoutMs}ms for ${safeUrl}`));
            });
            req.on("error", reject);

            if (body) {
                req.write(body);
            }

            req.end();
        });
    }
}

export const youtubeService = new YouTubeService();
