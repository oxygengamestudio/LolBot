import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, stat, rename, unlink, readdir, readFile, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config.js';
import type { Track } from '../types/index.js';
import { logger } from '../utils/Logger.js';
import { runtimeTelemetry } from '../services/RuntimeTelemetry.js';

const log = logger.createModuleLogger('MediaCache');
const MANIFEST_VERSION = 1;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_CACHE_TRACK_OUTPUT_BYTES = 256 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;

interface MediaIdentity {
    provider: string;
    sourceId: string;
    cacheKey: string;
}

interface CacheEntry extends MediaIdentity {
    path: string;
    size: number;
    downloadedAt: number;
    lastUsedAt: number;
    codec: string;
    container: 'ogg' | 'webm';
}

interface CacheManifest {
    version: number;
    entries: Array<{
        cacheKey: string;
        provider: string;
        sourceId: string;
        file: string;
        size: number;
        downloadedAt: number;
        lastUsedAt: number;
        codec: string;
        container: 'ogg' | 'webm';
    }>;
}

interface ResolvedStream {
    url: string;
    codec: string;
    container: 'ogg' | 'webm' | null;
}

export interface CachedTrackLease {
    path: string;
    release: () => void;
}

export class MediaCacheManager {
    private readonly cacheDir: string;
    private readonly manifestPath: string;
    private readonly maxBytes: number;
    private readonly maxAgeMs: number;
    private readonly maxConcurrentDownloads: number;
    private readonly ytdlpPath: string;
    private readonly ffmpegPath: string;
    private readonly entries: Map<string, CacheEntry> = new Map();
    private readonly inFlight: Map<string, Promise<string | null>> = new Map();
    private readonly inFlightAbortControllers = new Map<string, AbortController>();
    private readonly activeLeases = new Map<string, number>();
    private readonly pendingRemovals = new Set<string>();
    private readonly pendingUnlinks = new Map<string, Promise<void>>();
    private readonly preloadQueues = new Map<string, Track[]>();
    private readonly preloadGuildOrder: string[] = [];
    private readonly activePreloadGuilds = new Set<string>();
    private readonly activePreloads = new Map<string, { cacheKey: string; controller: AbortController }>();
    private readonly desiredPreloadKeys = new Map<string, Set<string>>();
    private readonly downloadWaiters: Array<() => void> = [];
    private readonly ready: Promise<void>;
    private activeDownloads = 0;
    private preloadWorkers = 0;
    private manifestWrite: Promise<void> = Promise.resolve();
    private manifestDirty = false;
    private warnedUnsafeYtdlpExtraArgsIgnored = false;
    private reservedOutputBytes = 0;
    private pendingUnlinkedBytes = 0;

    constructor() {
        this.cacheDir = join(config.paths.cache, 'audio');
        this.manifestPath = join(this.cacheDir, 'manifest.json');
        this.maxBytes = Math.max(1, config.audio.cacheMaxMb) * 1024 * 1024;
        this.maxAgeMs = Math.max(1, config.audio.cacheMaxAgeHours) * 60 * 60 * 1000;
        this.maxConcurrentDownloads = Math.max(1, config.audio.cacheDownloadConcurrency);
        this.ytdlpPath = this.resolveYtdlpPath();
        this.ffmpegPath = this.resolveFfmpegPath();
        this.ready = this.initialize().catch((error) => {
            log.error('Impossible d\'initialiser le cache audio persistant', error);
        });
        this.startCleanup();
    }

    private normalizeIdentity(trackOrId: Track | string): MediaIdentity {
        if (typeof trackOrId === 'string') {
            const separator = trackOrId.indexOf(':');
            if (separator > 0 && separator < trackOrId.length - 1) {
                return {
                    provider: trackOrId.slice(0, separator).toLowerCase(),
                    sourceId: trackOrId.slice(separator + 1),
                    cacheKey: `${trackOrId.slice(0, separator).toLowerCase()}:${trackOrId.slice(separator + 1)}`,
                };
            }
            return { provider: 'youtube', sourceId: trackOrId, cacheKey: `youtube:${trackOrId}` };
        }

        const provider = trackOrId.provider?.trim().toLowerCase() || 'youtube';
        const sourceId = trackOrId.sourceId?.trim() || trackOrId.id;
        return { provider, sourceId, cacheKey: `${provider}:${sourceId}` };
    }

    private async initialize(): Promise<void> {
        await mkdir(this.cacheDir, { recursive: true });
        await this.cleanupStaleTempFiles();
        await this.loadManifest();
        await this.rebuildIndexFromDisk();
        this.enforceCapacityLimits(new Set());
        await this.persistManifestNow();
        log.info(`Cache audio indexé: ${this.entries.size} piste(s), ${Math.round(this.getCacheBytes() / 1024 / 1024)}MB`);
    }

    private async cleanupStaleTempFiles(): Promise<void> {
        const files = await readdir(this.cacheDir, { withFileTypes: true });
        await Promise.all(files
            .filter((file) => file.isFile() && file.name.endsWith('.tmp'))
            .map((file) => unlink(join(this.cacheDir, file.name)).catch(() => undefined)));
    }

    private async loadManifest(): Promise<void> {
        if (!existsSync(this.manifestPath)) {
            return;
        }

        try {
            const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<CacheManifest>;
            if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
                log.warn('Manifest cache incompatible, reconstruction depuis le disque');
                return;
            }

            for (const item of parsed.entries) {
                if (!item || typeof item.cacheKey !== 'string' || typeof item.file !== 'string') {
                    continue;
                }
                const safeFile = basename(item.file);
                const path = join(this.cacheDir, safeFile);
                if (!existsSync(path)) {
                    continue;
                }
                const info = await stat(path);
                if (!info.isFile() || info.size <= 0) {
                    continue;
                }
                const container = item.container === 'webm' ? 'webm' : 'ogg';
                this.entries.set(item.cacheKey, {
                    cacheKey: item.cacheKey,
                    provider: item.provider || item.cacheKey.split(':', 1)[0] || 'youtube',
                    sourceId: item.sourceId || item.cacheKey.slice(item.cacheKey.indexOf(':') + 1),
                    path,
                    size: info.size,
                    downloadedAt: Number.isFinite(item.downloadedAt) ? item.downloadedAt : info.mtimeMs,
                    lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : info.mtimeMs,
                    codec: item.codec || 'opus',
                    container,
                });
            }
        } catch (error) {
            log.warn('Manifest cache illisible, reconstruction depuis le disque', error);
        }
    }

    private async rebuildIndexFromDisk(): Promise<void> {
        const files = await readdir(this.cacheDir, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile() || !['.ogg', '.webm'].includes(extname(file.name).toLowerCase())) {
                continue;
            }

            const originalPath = join(this.cacheDir, file.name);
            const extension = extname(file.name).slice(1).toLowerCase() as 'ogg' | 'webm';
            let identity: MediaIdentity;
            let finalPath = originalPath;

            if (file.name.startsWith('media-')) {
                const encoded = file.name.slice('media-'.length, -extname(file.name).length);
                try {
                    const cacheKey = Buffer.from(encoded, 'base64url').toString('utf8');
                    const separator = cacheKey.indexOf(':');
                    if (separator <= 0 || separator === cacheKey.length - 1) {
                        continue;
                    }
                    identity = {
                        cacheKey,
                        provider: cacheKey.slice(0, separator),
                        sourceId: cacheKey.slice(separator + 1),
                    };
                } catch {
                    continue;
                }
            } else {
                const legacyId = file.name.slice(0, -extname(file.name).length);
                identity = this.normalizeIdentity(legacyId);
                const migratedPath = this.getPathFor(identity.cacheKey, extension);
                if (!existsSync(migratedPath)) {
                    await rename(originalPath, migratedPath).catch(() => undefined);
                    if (existsSync(migratedPath)) {
                        finalPath = migratedPath;
                    }
                }
            }

            if (this.entries.has(identity.cacheKey) || !existsSync(finalPath)) {
                continue;
            }
            const info = await stat(finalPath);
            if (!info.isFile() || info.size <= 0) {
                continue;
            }
            this.entries.set(identity.cacheKey, {
                ...identity,
                path: finalPath,
                size: info.size,
                downloadedAt: info.mtimeMs,
                lastUsedAt: info.mtimeMs,
                codec: 'opus',
                container: extension,
            });
        }
    }

    private parseExtraArgs(rawArgs: string | undefined): string[] {
        if (!rawArgs) return [];
        const matches = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
        if (!matches) return [];
        return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ''));
    }

    private getUnsafeYtdlpExtraArgs(): string[] {
        const extraArgs = this.parseExtraArgs(process.env.YTDLP_EXTRA_ARGS);
        if (extraArgs.length === 0) {
            return [];
        }
        if (config.audio.allowUnsafeYtdlpExtraArgs) {
            return extraArgs;
        }
        if (!this.warnedUnsafeYtdlpExtraArgsIgnored) {
            this.warnedUnsafeYtdlpExtraArgsIgnored = true;
            log.warn('YTDLP_EXTRA_ARGS ignoré. Activez YTDLP_ALLOW_UNSAFE_EXTRA_ARGS uniquement dans un environnement maîtrisé.');
        }
        return [];
    }

    private getYtdlpExtraArgs(includeCookies = true): string[] {
        const args: string[] = [];
        const cookiesFromBrowser = includeCookies ? process.env.YTDLP_COOKIES_FROM_BROWSER : undefined;
        const cookies = includeCookies ? process.env.YTDLP_COOKIES : undefined;
        if (cookiesFromBrowser) {
            args.push('--cookies-from-browser', cookiesFromBrowser);
        } else if (cookies) {
            args.push('--cookies', cookies);
        }
        args.push(...this.getUnsafeYtdlpExtraArgs());
        return args;
    }

    private resolveYtdlpPath(): string {
        if (process.env.YTDLP_PATH) {
            return process.env.YTDLP_PATH;
        }
        const fileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const localPath = join(config.paths.data, 'bin', fileName);
        return existsSync(localPath) ? localPath : 'yt-dlp';
    }

    private resolveFfmpegPath(): string {
        return process.env.FFMPEG_PATH ?? 'ffmpeg';
    }

    async getTrackPath(trackOrId: Track | string): Promise<string | null> {
        await this.ready;
        const identity = this.normalizeIdentity(trackOrId);
        if (this.pendingRemovals.has(identity.cacheKey)) {
            runtimeTelemetry.recordCacheResult(false);
            return null;
        }
        const existing = this.entries.get(identity.cacheKey);
        if (!existing) {
            runtimeTelemetry.recordCacheResult(false);
            return null;
        }
        if (!existsSync(existing.path) || Date.now() - existing.lastUsedAt > this.maxAgeMs) {
            this.removeEntry(identity.cacheKey);
            runtimeTelemetry.recordCacheResult(false);
            return null;
        }
        runtimeTelemetry.recordCacheResult(true);
        existing.lastUsedAt = Date.now();
        this.scheduleManifestPersist();
        return existing.path;
    }

    async acquireTrackPath(trackOrId: Track | string): Promise<CachedTrackLease | null> {
        const path = await this.getTrackPath(trackOrId);
        if (!path) return null;

        const cacheKey = this.normalizeIdentity(trackOrId).cacheKey;
        const entry = this.entries.get(cacheKey);
        if (!entry || entry.path !== path || this.pendingRemovals.has(cacheKey)) {
            return null;
        }

        this.activeLeases.set(cacheKey, (this.activeLeases.get(cacheKey) ?? 0) + 1);
        let released = false;
        return {
            path,
            release: () => {
                if (released) return;
                released = true;
                this.releaseTrackLease(cacheKey);
            },
        };
    }

    getStreamUrl(trackOrId: Track | string): Promise<string | null> {
        return this.resolveStream(trackOrId).then((result) => result?.url ?? null);
    }

    async ensureCached(track: Track, force = false, signal?: AbortSignal): Promise<string | null> {
        await this.ready;
        if (signal?.aborted) return null;
        const identity = this.normalizeIdentity(track);
        if (track.isLive) {
            return null;
        }
        const existing = await this.getTrackPath(track);
        if (existing && !force) {
            return existing;
        }
        const pending = this.inFlight.get(identity.cacheKey);
        if (pending) {
            return this.waitForInFlight(pending, signal);
        }

        const downloadController = new AbortController();
        const relayAbort = () => downloadController.abort();
        signal?.addEventListener('abort', relayAbort, { once: true });
        this.inFlightAbortControllers.set(identity.cacheKey, downloadController);
        const download = this.withDownloadSlot(() => this.downloadTrack(track, force, downloadController.signal))
            .catch((error) => {
                log.warn(`Échec du pré-téléchargement de ${identity.cacheKey}`, error);
                return null;
            })
            .finally(() => {
                signal?.removeEventListener('abort', relayAbort);
                this.inFlight.delete(identity.cacheKey);
                if (this.inFlightAbortControllers.get(identity.cacheKey) === downloadController) {
                    this.inFlightAbortControllers.delete(identity.cacheKey);
                }
            });
        this.inFlight.set(identity.cacheKey, download);
        return download;
    }

    preloadTracks(tracks: Track[], guildId = 'global'): void {
        const candidates = tracks.slice(0, config.audio.cacheAhead);
        const desiredKeys = new Set(candidates.map((track) => this.normalizeIdentity(track).cacheKey));
        this.desiredPreloadKeys.set(guildId, desiredKeys);
        const active = this.activePreloads.get(guildId);
        if (
            active &&
            !desiredKeys.has(active.cacheKey) &&
            !this.isDesiredByAnotherGuild(active.cacheKey, guildId)
        ) {
            active.controller.abort();
            this.inFlightAbortControllers.get(active.cacheKey)?.abort();
        }
        const queue: Track[] = [];
        for (const track of candidates) {
            const key = this.normalizeIdentity(track).cacheKey;
            if (
                this.entries.has(key) ||
                this.inFlight.has(key) ||
                queue.some((candidate) => this.normalizeIdentity(candidate).cacheKey === key)
            ) {
                continue;
            }
            queue.push(track);
        }

        this.preloadQueues.set(guildId, queue);
        this.removeGuildFromPreloadOrder(guildId);
        if (queue.length > 0 && !this.activePreloadGuilds.has(guildId)) {
            this.preloadGuildOrder.push(guildId);
        }
        this.startPreloadWorkers();
    }

    private startPreloadWorkers(): void {
        while (this.preloadWorkers < this.maxConcurrentDownloads && this.preloadGuildOrder.length > 0) {
            this.preloadWorkers += 1;
            void this.preloadWorker().finally(() => {
                this.preloadWorkers -= 1;
                if (this.preloadGuildOrder.length > 0) {
                    this.startPreloadWorkers();
                }
            });
        }
    }

    private async preloadWorker(): Promise<void> {
        while (true) {
            const next = this.takeNextPreload();
            if (!next) {
                return;
            }
            const { guildId, track } = next;
            const cacheKey = this.normalizeIdentity(track).cacheKey;
            const controller = new AbortController();
            this.activePreloads.set(guildId, { cacheKey, controller });
            try {
                if (await this.getTrackPath(track)) {
                    log.trace(`Cache hit: ${track.title}`);
                    continue;
                }
                log.debug(`Pré-téléchargement: ${track.title}`);
                await this.ensureCached(track, false, controller.signal);
            } finally {
                const active = this.activePreloads.get(guildId);
                if (active?.controller === controller) {
                    this.activePreloads.delete(guildId);
                }
                this.activePreloadGuilds.delete(guildId);
                const queue = this.preloadQueues.get(guildId);
                if (queue && queue.length > 0) {
                    if (!this.preloadGuildOrder.includes(guildId)) {
                        this.preloadGuildOrder.push(guildId);
                    }
                } else {
                    this.preloadQueues.delete(guildId);
                }
                if ((this.desiredPreloadKeys.get(guildId)?.size ?? 0) === 0) {
                    this.desiredPreloadKeys.delete(guildId);
                }
            }
        }
    }

    private takeNextPreload(): { guildId: string; track: Track } | null {
        const candidates = this.preloadGuildOrder.length;
        for (let index = 0; index < candidates; index += 1) {
            const guildId = this.preloadGuildOrder.shift()!;
            if (this.activePreloadGuilds.has(guildId)) {
                this.preloadGuildOrder.push(guildId);
                continue;
            }
            const queue = this.preloadQueues.get(guildId);
            if (!queue || queue.length === 0) {
                this.preloadQueues.delete(guildId);
                continue;
            }
            const track = queue.shift()!;
            this.activePreloadGuilds.add(guildId);
            return { guildId, track };
        }
        return null;
    }

    private removeGuildFromPreloadOrder(guildId: string): void {
        for (let index = this.preloadGuildOrder.length - 1; index >= 0; index -= 1) {
            if (this.preloadGuildOrder[index] === guildId) {
                this.preloadGuildOrder.splice(index, 1);
            }
        }
    }

    private isDesiredByAnotherGuild(cacheKey: string, excludedGuildId: string): boolean {
        for (const [guildId, desired] of this.desiredPreloadKeys) {
            if (guildId !== excludedGuildId && desired.has(cacheKey)) return true;
        }
        return false;
    }

    private waitForInFlight(pending: Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
        if (!signal) return pending;
        if (signal.aborted) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                cleanup();
                resolve(null);
            };
            const cleanup = () => signal.removeEventListener('abort', onAbort);
            signal.addEventListener('abort', onAbort, { once: true });
            pending.then(
                (value) => { cleanup(); resolve(value); },
                (error) => { cleanup(); reject(error); }
            );
        });
    }

    clearTrack(trackOrId: Track | string): void {
        this.removeEntry(this.normalizeIdentity(trackOrId).cacheKey);
    }

    /**
     * Conserve le cache entre les sessions. Les identifiants actifs sont protégés
     * pendant l'éviction TTL/LRU, mais les autres pistes ne sont plus supprimées
     * simplement parce qu'elles ont quitté une queue.
     */
    clearUnused(keepTrackIds: Set<string>): void {
        const protectedKeys = new Set(Array.from(keepTrackIds, (id) => this.normalizeIdentity(id).cacheKey));
        this.enforceCapacityLimits(protectedKeys);
    }

    clearAll(): void {
        for (const key of Array.from(this.entries.keys())) {
            this.removeEntry(key);
        }
    }

    getCacheSize(): number {
        return this.entries.size;
    }

    private async downloadTrack(track: Track, force: boolean, signal?: AbortSignal): Promise<string | null> {
        const identity = this.normalizeIdentity(track);
        if ((this.activeLeases.get(identity.cacheKey) ?? 0) > 0) {
            return null;
        }
        const stream = await this.resolveStream(track, signal);
        if (!stream) {
            return null;
        }
        if (signal?.aborted) return null;

        const canCopy = stream.codec === 'opus' && (stream.container === 'ogg' || stream.container === 'webm');
        const container: 'ogg' | 'webm' = canCopy ? stream.container! : 'ogg';
        const finalPath = this.getPathFor(identity.cacheKey, container);
        const tempPath = `${finalPath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
        const outputBudget = await this.reserveOutputBudget(identity.cacheKey);
        if (outputBudget <= 0) {
            log.warn(`Cache saturé, téléchargement abandonné pour ${identity.cacheKey}`);
            return null;
        }
        const ffmpegArgs = canCopy
            ? ['-loglevel', 'warning', '-i', stream.url, '-vn', '-map', '0:a:0', '-c:a', 'copy', '-f', container, 'pipe:1']
            : [
                '-loglevel', 'warning', '-i', stream.url, '-vn',
                '-acodec', 'libopus', '-b:a', '128k', '-f', 'ogg', '-ar', '48000', '-ac', '2', 'pipe:1',
            ];

        try {
            const result = await this.runProcessToFile(
                this.ffmpegPath,
                ffmpegArgs,
                tempPath,
                outputBudget,
                signal
            );
            if (!result.success) {
                await unlink(tempPath).catch(() => undefined);
                log.warn(`FFmpeg cache ${identity.cacheKey} failed`, result.error);
                return null;
            }
            const info = await stat(tempPath).catch(() => null);
            if (!info || info.size <= 0 || info.size > outputBudget) {
                await unlink(tempPath).catch(() => undefined);
                return null;
            }

            if (force) {
                this.removeEntry(identity.cacheKey);
            }
            await unlink(finalPath).catch(() => undefined);
            await rename(tempPath, finalPath);
            const now = Date.now();
            this.entries.set(identity.cacheKey, {
                ...identity,
                path: finalPath,
                size: info.size,
                downloadedAt: now,
                lastUsedAt: now,
                codec: canCopy ? stream.codec : 'opus',
                container,
            });
            this.enforceCapacityLimits(new Set([identity.cacheKey]));
            this.scheduleManifestPersist();
            return finalPath;
        } finally {
            this.reservedOutputBytes = Math.max(0, this.reservedOutputBytes - outputBudget);
        }
    }

    private async resolveStream(trackOrId: Track | string, signal?: AbortSignal): Promise<ResolvedStream | null> {
        const identity = this.normalizeIdentity(trackOrId);
        const track = typeof trackOrId === 'string' ? null : trackOrId;
        if (identity.provider !== 'youtube' && identity.provider !== 'soundcloud') {
            log.debug(`Cache provider non pris en charge: ${identity.provider}`);
            return null;
        }
        if (identity.provider === 'soundcloud' && !track?.canonicalUrl && !track?.url) {
            log.debug('Cache SoundCloud ignore sans URL canonique');
            return null;
        }

        const selectors = [
            'bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
            'bestaudio/best',
        ];
        for (const includeCookies of [true, false]) {
            for (const format of selectors) {
                const output = await this.runYtdlpText([
                    ...this.getYtdlpExtraArgs(includeCookies), '--no-warnings', '--no-playlist',
                    '-f', format, '--get-url', track?.canonicalUrl || track?.url || `https://www.youtube.com/watch?v=${identity.sourceId}`,
                ], signal);
                if (output) {
                    return this.describeStream(output, track);
                }
            }
        }
        return null;
    }

    private describeStream(url: string, track: Track | null): ResolvedStream {
        const decoded = this.safeDecodeUrl(url).toLowerCase();
        const declaredCodec = track?.codec?.toLowerCase() || '';
        const declaredContainer = track?.container?.toLowerCase() || '';
        const isWebm = declaredContainer === 'webm' || /mime=audio\/webm/.test(decoded) || /\.webm(?:$|[?#])/.test(decoded);
        const isOgg = declaredContainer === 'ogg' || declaredContainer === 'oga' || /mime=audio\/(?:ogg|opus)/.test(decoded) || /\.ogg(?:$|[?#])/.test(decoded);
        const codec = declaredCodec.includes('opus') || isWebm || isOgg ? 'opus' : declaredCodec || 'unknown';
        return { url, codec, container: isWebm ? 'webm' : isOgg ? 'ogg' : null };
    }

    private safeDecodeUrl(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    private runYtdlpText(args: string[], signal?: AbortSignal): Promise<string | null> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(null);
                return;
            }
            let stdout = '';
            let stderr = '';
            let settled = false;
            let terminalError: string | undefined;
            const child = spawn(this.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const finish = (result: string | null, error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                if (error) log.trace('yt-dlp get-url error', error.slice(0, 300));
                resolve(result);
            };
            const failAndTerminate = (error: string) => {
                if (settled || terminalError) return;
                terminalError = error;
                this.terminateProcess(child);
                child.stdout?.resume();
                child.stderr?.resume();
            };
            const append = (current: string, chunk: Buffer): string | null => {
                if (Buffer.byteLength(current) + chunk.length > MAX_PROCESS_OUTPUT_BYTES) {
                    failAndTerminate('Sortie yt-dlp trop volumineuse');
                    return null;
                }
                return current + chunk.toString();
            };
            child.stdout?.on('data', (data: Buffer) => {
                if (terminalError) return;
                const next = append(stdout, data);
                if (next !== null) stdout = next;
            });
            child.stderr?.on('data', (data: Buffer) => {
                if (terminalError) return;
                const next = append(stderr, data);
                if (next !== null) stderr = next;
            });
            child.on('error', (error) => {
                if (child.pid === undefined) finish(null, error.message);
                else failAndTerminate(error.message);
            });
            child.on('close', (code) => {
                if (terminalError) return finish(null, terminalError);
                if (code !== 0) return finish(null, stderr.trim());
                const line = stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
                finish(line ?? null);
            });
            const timeout = setTimeout(() => {
                failAndTerminate(`Timeout après ${config.audio.ytDlpTimeoutMs}ms`);
            }, config.audio.ytDlpTimeoutMs);
            timeout.unref?.();
            const onAbort = () => {
                failAndTerminate('Préchargement yt-dlp annulé');
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    private runProcess(command: string, args: string[], signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve({ success: false, error: 'Processus annulé' });
                return;
            }
            let stderr = '';
            let settled = false;
            let terminalError: string | undefined;
            const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
            const finish = (success: boolean, error?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                resolve({ success, error: error || stderr.trim() || undefined });
            };
            const failAndTerminate = (error: string) => {
                if (settled || terminalError) return;
                terminalError = error;
                this.terminateProcess(child);
                child.stderr?.resume();
            };
            child.stderr?.on('data', (data: Buffer) => {
                if (terminalError) return;
                if (Buffer.byteLength(stderr) + data.length > MAX_PROCESS_OUTPUT_BYTES) {
                    failAndTerminate('Sortie processus trop volumineuse');
                    return;
                }
                stderr += data.toString();
            });
            child.on('error', (error) => {
                if (child.pid === undefined) finish(false, error.message);
                else failAndTerminate(error.message);
            });
            child.on('close', (code) => finish(!terminalError && code === 0, terminalError));
            const timeout = setTimeout(() => {
                failAndTerminate(`Timeout après ${config.audio.cacheDownloadTimeoutMs}ms`);
            }, config.audio.cacheDownloadTimeoutMs);
            timeout.unref?.();
            const onAbort = () => {
                failAndTerminate('Préchargement FFmpeg annulé');
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Écrit stdout dans un fichier temporaire en refusant chaque bloc qui
     * dépasserait le budget. Les fichiers FFmpeg en cours sont ainsi bornés,
     * pas seulement contrôlés une fois le téléchargement terminé.
     */
    private runProcessToFile(
        command: string,
        args: string[],
        outputPath: string,
        maxOutputBytes: number,
        signal?: AbortSignal
    ): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve({ success: false, error: 'Processus annulé' });
                return;
            }

            let stderr = '';
            let writtenBytes = 0;
            let processClosed = false;
            let streamClosed = false;
            let processSucceeded = false;
            let settled = false;
            let terminalError: string | undefined;
            let timeout: NodeJS.Timeout | undefined;
            let onAbort: (() => void) | undefined;
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
            const limiter = new Transform({
                transform: (chunk: Buffer, _encoding, callback) => {
                    if (writtenBytes + chunk.length > maxOutputBytes) {
                        callback(new Error(`Sortie média supérieure à ${maxOutputBytes} octets`));
                        return;
                    }
                    writtenBytes += chunk.length;
                    callback(null, chunk);
                },
            });

            const finish = (success: boolean, error?: string) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                if (onAbort) signal?.removeEventListener('abort', onAbort);
                resolve({ success, error: error || stderr.trim() || undefined });
            };
            const maybeFinish = () => {
                if (processClosed && streamClosed) {
                    finish(!terminalError && processSucceeded, terminalError);
                }
            };
            const fail = (error: string) => {
                if (settled || terminalError) return;
                terminalError = error;
                this.terminateProcess(child);
                limiter.destroy();
                output.destroy();
            };
            onAbort = () => fail('Préchargement FFmpeg annulé');
            timeout = setTimeout(() => {
                fail(`Timeout après ${config.audio.cacheDownloadTimeoutMs}ms`);
            }, config.audio.cacheDownloadTimeoutMs);
            timeout.unref?.();
            signal?.addEventListener('abort', onAbort, { once: true });

            child.stderr?.on('data', (data: Buffer) => {
                if (terminalError) return;
                if (Buffer.byteLength(stderr) + data.length > MAX_PROCESS_OUTPUT_BYTES) {
                    fail('Sortie processus trop volumineuse');
                    return;
                }
                stderr += data.toString();
            });
            child.on('error', (error) => {
                fail(error.message);
                processClosed = true;
                maybeFinish();
            });
            child.on('close', (code) => {
                processClosed = true;
                processSucceeded = code === 0;
                if (!processSucceeded && !terminalError) {
                    terminalError = stderr.trim() || `Processus terminé avec le code ${code ?? 'inconnu'}`;
                    limiter.destroy();
                    output.destroy();
                }
                maybeFinish();
            });

            if (!child.stdout) {
                fail('Stdout FFmpeg indisponible');
                return;
            }
            void pipeline(child.stdout, limiter, output).then(() => {
                streamClosed = true;
                maybeFinish();
            }).catch((error: unknown) => {
                if (!terminalError) {
                    fail(error instanceof Error ? error.message : String(error));
                }
                streamClosed = true;
                maybeFinish();
            });
        });
    }

    private terminateProcess(child: ChildProcess): void {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
            child.kill('SIGTERM');
        } catch {
            return;
        }
        const forceKill = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                try { child.kill('SIGKILL'); } catch { /* already closed */ }
            }
        }, PROCESS_KILL_GRACE_MS);
        forceKill.unref?.();
        child.once('close', () => clearTimeout(forceKill));
    }

    private async withDownloadSlot<T>(operation: () => Promise<T>): Promise<T> {
        if (this.activeDownloads >= this.maxConcurrentDownloads) {
            await new Promise<void>((resolve) => this.downloadWaiters.push(resolve));
        }
        this.activeDownloads += 1;
        try {
            return await operation();
        } finally {
            this.activeDownloads -= 1;
            this.downloadWaiters.shift()?.();
        }
    }

    private getPathFor(cacheKey: string, container: 'ogg' | 'webm'): string {
        return join(this.cacheDir, `media-${Buffer.from(cacheKey).toString('base64url')}.${container}`);
    }

    private removeEntry(cacheKey: string): boolean {
        const entry = this.entries.get(cacheKey);
        if (!entry) return false;
        if ((this.activeLeases.get(cacheKey) ?? 0) > 0) {
            this.pendingRemovals.add(cacheKey);
            return false;
        }
        this.pendingRemovals.delete(cacheKey);
        this.entries.delete(cacheKey);
        this.pendingUnlinkedBytes += entry.size;
        let physicalRemoval!: Promise<void>;
        physicalRemoval = unlink(entry.path).then(() => {
            this.pendingUnlinkedBytes = Math.max(0, this.pendingUnlinkedBytes - entry.size);
        }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                this.pendingUnlinkedBytes = Math.max(0, this.pendingUnlinkedBytes - entry.size);
                return;
            }
            // Conserver les octets dans le budget tant que le système n'a pas
            // confirmé la suppression physique du fichier.
            log.warn(`Suppression physique du cache impossible: ${cacheKey}`, error);
        }).finally(() => {
            if (this.pendingUnlinks.get(cacheKey) === physicalRemoval) {
                this.pendingUnlinks.delete(cacheKey);
            }
        });
        this.pendingUnlinks.set(cacheKey, physicalRemoval);
        this.scheduleManifestPersist();
        log.debug(`Suppression cache: ${cacheKey}`);
        return true;
    }

    private enforceCapacityLimits(protectedKeys: Set<string>): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (!protectedKeys.has(key) && now - entry.lastUsedAt > this.maxAgeMs) {
                this.removeEntry(key);
            }
        }
        let total = this.getCacheBytes();
        if (total <= this.maxBytes) return;
        const candidates = Array.from(this.entries.values())
            .filter((entry) => !protectedKeys.has(entry.cacheKey))
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        for (const candidate of candidates) {
            if (total <= this.maxBytes) break;
            if (this.removeEntry(candidate.cacheKey)) {
                total -= candidate.size;
            }
        }
        if (total > this.maxBytes) {
            log.warn(`Cache audio dépasse la limite (${Math.round(total / 1024 / 1024)}MB / ${config.audio.cacheMaxMb}MB)`);
        }
    }

    private getCacheBytes(): number {
        let total = 0;
        for (const entry of this.entries.values()) total += entry.size;
        return total;
    }

    private async reserveOutputBudget(protectedCacheKey: string): Promise<number> {
        const desired = Math.min(this.maxBytes, MAX_CACHE_TRACK_OUTPUT_BYTES);
        let available = this.maxBytes - this.getCacheBytes() - this.pendingUnlinkedBytes - this.reservedOutputBytes;
        if (available < desired && this.pendingUnlinks.size > 0) {
            await Promise.allSettled(this.pendingUnlinks.values());
            available = this.maxBytes - this.getCacheBytes() - this.pendingUnlinkedBytes - this.reservedOutputBytes;
        }
        if (available < desired) {
            const candidates = Array.from(this.entries.values())
                .filter((entry) =>
                    entry.cacheKey !== protectedCacheKey &&
                    (this.activeLeases.get(entry.cacheKey) ?? 0) === 0
                )
                .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
            const removals: Promise<void>[] = [];
            let projectedAvailable = available;
            for (const candidate of candidates) {
                if (projectedAvailable >= desired) break;
                if (this.removeEntry(candidate.cacheKey)) {
                    projectedAvailable += candidate.size;
                    const pending = this.pendingUnlinks.get(candidate.cacheKey);
                    if (pending) removals.push(pending);
                }
            }
            if (removals.length > 0) {
                await Promise.allSettled(removals);
                available = this.maxBytes - this.getCacheBytes() - this.pendingUnlinkedBytes - this.reservedOutputBytes;
            }
        }

        const reservation = Math.max(0, Math.min(desired, available));
        this.reservedOutputBytes += reservation;
        return reservation;
    }

    private releaseTrackLease(cacheKey: string): void {
        const current = this.activeLeases.get(cacheKey) ?? 0;
        if (current <= 1) {
            this.activeLeases.delete(cacheKey);
            if (this.pendingRemovals.has(cacheKey)) {
                this.removeEntry(cacheKey);
            }
            return;
        }
        this.activeLeases.set(cacheKey, current - 1);
    }

    private scheduleManifestPersist(): void {
        this.manifestDirty = true;
        this.manifestWrite = this.manifestWrite.then(async () => {
            if (!this.manifestDirty) return;
            this.manifestDirty = false;
            await this.persistManifestNow();
        }).catch((error) => log.warn('Écriture du manifest cache impossible', error));
    }

    private async persistManifestNow(): Promise<void> {
        const manifest: CacheManifest = {
            version: MANIFEST_VERSION,
            entries: Array.from(this.entries.values(), (entry) => ({
                cacheKey: entry.cacheKey,
                provider: entry.provider,
                sourceId: entry.sourceId,
                file: basename(entry.path),
                size: entry.size,
                downloadedAt: entry.downloadedAt,
                lastUsedAt: entry.lastUsedAt,
                codec: entry.codec,
                container: entry.container,
            })),
        };
        const tempPath = `${this.manifestPath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(tempPath, this.manifestPath);
    }

    private startCleanup(): void {
        const timer = setInterval(() => {
            void this.ready.then(() => this.enforceCapacityLimits(new Set()));
        }, 5 * 60 * 1000);
        timer.unref?.();
    }
}

export const mediaCacheManager = new MediaCacheManager();
