import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, stat, rename, unlink } from 'fs/promises';
import { join } from 'path';
import http from 'http';
import https from 'https';
import { config } from '../config.js';
import type { Track } from '../types/index.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('MediaCache');

interface CacheEntry {
    trackId: string;
    path: string;
    size: number;
    downloadedAt: number;
    lastUsedAt: number;
}

export class MediaCacheManager {
    private readonly cacheDir: string;
    private readonly maxBytes: number;
    private readonly maxAgeMs: number;
    private readonly ytdlpPath: string;
    private readonly ffmpegPath: string;
    private readonly entries: Map<string, CacheEntry> = new Map();
    private readonly inFlight: Map<string, Promise<string | null>> = new Map();
    private readonly preloadQueue: Track[] = [];
    private isPreloading = false;

    constructor() {
        this.cacheDir = join(config.paths.cache, 'audio');
        this.maxBytes = Math.max(1, config.audio.cacheMaxMb) * 1024 * 1024;
        this.maxAgeMs = config.audio.cacheMaxAgeHours * 60 * 60 * 1000;
        this.ytdlpPath = this.resolveYtdlpPath();
        this.ffmpegPath = this.resolveFfmpegPath();
        this.ensureCacheDir();
        this.startCleanup();
    }

    private hasCookieEnv(): boolean {
        if (process.env.YTDLP_COOKIES_FROM_BROWSER || process.env.YTDLP_COOKIES) {
            return true;
        }

        const extraArgs = this.parseExtraArgs(process.env.YTDLP_EXTRA_ARGS);
        return extraArgs.some((arg) =>
            arg === '--cookies' ||
            arg === '--cookies-from-browser' ||
            arg.startsWith('--cookies=') ||
            arg.startsWith('--cookies-from-browser=')
        );
    }

    private parseExtraArgs(rawArgs: string | undefined): string[] {
        if (!rawArgs) return [];
        const matches = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
        if (!matches) return [];
        return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ''));
    }

    private getYtdlpExtraArgs(includeCookies: boolean = true): string[] {
        const args: string[] = [];
        const cookiesFromBrowser = includeCookies ? process.env.YTDLP_COOKIES_FROM_BROWSER : undefined;
        const cookies = includeCookies ? process.env.YTDLP_COOKIES : undefined;
        const extraArgs = this.parseExtraArgs(process.env.YTDLP_EXTRA_ARGS);

        if (cookiesFromBrowser) {
            args.push('--cookies-from-browser', cookiesFromBrowser);
        } else if (cookies) {
            args.push('--cookies', cookies);
        }

        if (extraArgs.length > 0) {
            args.push(...extraArgs);
        }

        return args;
    }

    private resolveYtdlpPath(): string {
        const env = process.env.YTDLP_PATH;
        if (env) {
            return env;
        }

        const fileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const localPath = join(config.paths.data, 'bin', fileName);
        return existsSync(localPath) ? localPath : 'yt-dlp';
    }

    private resolveFfmpegPath(): string {
        return process.env.FFMPEG_PATH ?? 'ffmpeg';
    }

    private ensureCacheDir(): void {
        mkdir(this.cacheDir, { recursive: true }).catch((error) => {
            log.error('Impossible de créer le dossier cache audio', error);
        });
    }

    async getTrackPath(trackId: string): Promise<string | null> {
        const existing = this.entries.get(trackId);
        if (existing) {
            if (!existsSync(existing.path)) {
                this.entries.delete(trackId);
            } else {
                existing.lastUsedAt = Date.now();
                return existing.path;
            }
        }

        const fallbackPath = this.getTrackPathCandidates(trackId)[0];
        if (fallbackPath && existsSync(fallbackPath)) {
            const stats = await stat(fallbackPath);
            const entry: CacheEntry = {
                trackId,
                path: fallbackPath,
                size: stats.size,
                downloadedAt: stats.mtimeMs,
                lastUsedAt: Date.now(),
            };
            this.entries.set(trackId, entry);
            return fallbackPath;
        }

        return null;
    }

    getStreamUrl(trackId: string): Promise<string | null> {
        return this.resolveStreamUrl(trackId);
    }

    async ensureCached(track: Track, force = false): Promise<string | null> {
        const existing = await this.getTrackPath(track.id);
        if (existing && !force) {
            return existing;
        }

        if (this.inFlight.has(track.id)) {
            return this.inFlight.get(track.id)!;
        }

        const download = this.downloadTrack(track)
            .then((path) => {
                this.inFlight.delete(track.id);
                return path;
            })
            .catch((error) => {
                log.warn(`Échec du pré-téléchargement de ${track.id}`, error);
                this.inFlight.delete(track.id);
                return null;
            });

        this.inFlight.set(track.id, download);
        return download;
    }

    preloadTracks(tracks: Track[]): void {
        if (this.preloadQueue.length === 0) {
            this.preloadQueue.push(...tracks);
        } else {
            for (const track of tracks) {
                if (!this.preloadQueue.some((queued) => queued.id === track.id)) {
                    this.preloadQueue.push(track);
                }
            }
        }

        if (!this.isPreloading) {
            this.processPreloadQueue().catch((error) => {
                log.warn('Préchargement en arrière-plan interrompu', error);
            });
        }
    }

    private async processPreloadQueue(): Promise<void> {
        if (this.isPreloading) {
            return;
        }

        this.isPreloading = true;
        try {
            const toPreload = this.preloadQueue.splice(0, config.audio.cacheAhead);
            for (const track of toPreload) {
                const cached = await this.getTrackPath(track.id);
                if (cached) {
                    log.trace(`Cache hit: ${track.title}`);
                    continue;
                }
                log.debug(`Pré-téléchargement: ${track.title}`);
                await this.ensureCached(track);
            }
        } finally {
            this.isPreloading = false;
        }
    }

    clearTrack(trackId: string): void {
        const entry = this.entries.get(trackId);
        if (!entry) {
            return;
        }

        if (existsSync(entry.path)) {
            unlink(entry.path).catch(() => {});
        }
        this.entries.delete(trackId);
        log.debug(`Suppression cache: ${trackId}`);
    }

    clearUnused(keepTrackIds: Set<string>): void {
        for (const [trackId, entry] of this.entries) {
            if (!keepTrackIds.has(trackId)) {
                this.clearTrack(trackId);
            }
        }
        this.enforceCapacityLimits(keepTrackIds);
    }

    clearAll(): void {
        for (const trackId of this.entries.keys()) {
            this.clearTrack(trackId);
        }
    }

    getCacheSize(): number {
        return this.entries.size;
    }

    private async downloadTrack(track: Track): Promise<string | null> {
        const finalPath = this.getTrackPathCandidates(track.id)[0];
        const tempPath = `${finalPath}.tmp`;

        const streamUrl = await this.resolveStreamUrl(track.id);
        if (!streamUrl) {
            return null;
        }

        const ffmpegArgs = [
            '-loglevel', 'warning',
            '-y',
            '-i', streamUrl,
            '-vn',
            '-acodec', 'libopus',
            '-b:a', '128k',
            '-f', 'ogg',
            '-ar', '48000',
            '-ac', '2',
            tempPath,
        ];

        const downloadResult = await this.runProcess(this.ffmpegPath, ffmpegArgs);
        if (!downloadResult.success) {
            log.warn(`FFmpeg cache ${track.id} failed`, downloadResult.error);
            return null;
        }

        const stats = await stat(tempPath);
        if (stats.size <= 0) {
            return null;
        }

        await rename(tempPath, finalPath);
        const entry: CacheEntry = {
            trackId: track.id,
            path: finalPath,
            size: stats.size,
            downloadedAt: Date.now(),
            lastUsedAt: Date.now(),
        };
        this.entries.set(track.id, entry);
        this.enforceCapacityLimits(new Set(this.entries.keys()));
        return finalPath;
    }

    private async resolveStreamUrl(videoId: string): Promise<string | null> {
        const selectors = [
            'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
            'bestaudio/best',
        ];

        const includeCookieAttempts = [true, false];
        for (const includeCookies of includeCookieAttempts) {
            for (const format of selectors) {
                const output = await this.runYtdlpText([
                    ...this.getYtdlpExtraArgs(includeCookies),
                    '--no-warnings',
                    '--no-playlist',
                    '-f', format,
                    '--get-url',
                    `https://www.youtube.com/watch?v=${videoId}`,
                ]);

                if (output) {
                    return output;
                }
            }
        }

        return null;
    }

    private runYtdlpText(args: string[]): Promise<string | null> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            const child = spawn(this.ytdlpPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            const finish = (result: string | null, error?: string) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (result) {
                    resolve(result);
                    return;
                }
                if (error) {
                    log.trace('yt-dlp get-url error', error.slice(0, 300));
                }
                resolve(null);
            };

            child.on('error', (error) => {
                finish(null, error.message);
            });
            child.on('close', (code) => {
                if (code !== 0) {
                    finish(null, stderr.trim());
                    return;
                }

                const line = stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .find((line) => line.length > 0);

                finish(line ?? null);
            });

            setTimeout(() => {
                child.kill();
                finish(null, `Timeout après ${config.audio.ytDlpTimeoutMs}ms`);
            }, config.audio.ytDlpTimeoutMs);
        });
    }

    private runProcess(command: string, args: string[]): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            let stderr = '';
            let settled = false;

            const child = spawn(command, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            const finish = (success: boolean) => {
                if (settled) return;
                settled = true;
                resolve({ success, error: stderr.trim() || undefined });
            };

            child.on('error', (error) => {
                finish(false);
                log.debug(`Erreur process ${command}`, error);
            });
            child.on('close', (code) => {
                finish(code === 0);
            });

            setTimeout(() => {
                child.kill();
                finish(false);
            }, config.audio.cacheDownloadTimeoutMs);
        });
    }

    private getTrackPathCandidates(trackId: string): string[] {
        return [join(this.cacheDir, `${trackId}.ogg`)];
    }

    private enforceCapacityLimits(keepTrackIds: Set<string>): void {
        this.cleanupExpired(keepTrackIds);
        this.cleanupMaxSize(keepTrackIds);
    }

    private cleanupExpired(keepTrackIds: Set<string>): void {
        const now = Date.now();
        for (const [trackId, entry] of this.entries) {
            const isStale = now - entry.lastUsedAt > this.maxAgeMs;
            if (isStale && !keepTrackIds.has(trackId)) {
                this.clearTrack(trackId);
            }
        }
    }

    private cleanupMaxSize(keepTrackIds: Set<string>): void {
        let total = this.getCacheBytes();
        if (total <= this.maxBytes) {
            return;
        }

        const candidates = Array.from(this.entries.values())
            .filter((entry) => !keepTrackIds.has(entry.trackId))
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

        for (const candidate of candidates) {
            if (total <= this.maxBytes) {
                break;
            }

            this.clearTrack(candidate.trackId);
            total = this.getCacheBytes();
        }

        if (total > this.maxBytes) {
            log.warn(`Cache audio dépasse la limite (${Math.round(total / 1024 / 1024)}MB / ${config.audio.cacheMaxMb}MB)`);
        }
    }

    private getCacheBytes(): number {
        let total = 0;
        for (const entry of this.entries.values()) {
            total += entry.size;
        }
        return total;
    }

    private startCleanup(): void {
        setInterval(() => {
            this.enforceCapacityLimits(new Set(this.entries.keys()));
        }, 5 * 60 * 1000);
    }
}

export const mediaCacheManager = new MediaCacheManager();
