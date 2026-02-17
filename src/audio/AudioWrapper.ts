import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Transform } from 'stream';
import type { ChildProcess } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { mkdir, chmod, rename, unlink, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import http from 'http';
import https from 'https';
import { createAudioResource, StreamType, AudioResource } from '@discordjs/voice';
import type { Track } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('AudioWrapper');

interface CacheEntry {
    guildId: string;
    trackId: string;
    resource: AudioResource | null;
    streamUrl: string | null;
    timestamp: number;
}

interface ResourceMetadata {
    trackId: string;
    teardown: () => void;
    createdAt: number;
}

interface WarmResourceEntry {
    warmedAt: number;
    expiresAt: number;
}

export class AudioWrapper extends EventEmitter {
    private cache: Map<string, CacheEntry> = new Map();
    private preloadingGuilds: Set<string> = new Set();
    private ffmpegPath: string = 'ffmpeg';
    private ytdlpPath: string = 'yt-dlp';
    private ffmpegAvailable: boolean = false;
    private ytdlpAvailable: boolean = false;
    private dependenciesReady: Promise<boolean> | null = null;
    private warmTracks: Map<string, WarmResourceEntry> = new Map();
    private warmupInFlight: Map<string, Promise<void>> = new Map();
    private readonly discordOpusBitrateKbps = 128;
    private readonly streamReadyWaitMs = 750;
    private readonly warmResourceTtlMs = 90_000;

    constructor() {
        super();
        log.info('AudioWrapper initialisé');
        mkdirSync(config.paths.cache, { recursive: true });
        this.dependenciesReady = this.checkDependencies();
        this.startCacheCleanup();
        void this.cleanupAllStaleTemp();
    }

    /**
     * Vérifie que FFmpeg et yt-dlp sont disponibles
     */
    private async checkDependencies(): Promise<boolean> {
        const envFfmpeg = process.env.FFMPEG_PATH;
        const envYtdlp = process.env.YTDLP_PATH;

        if (envFfmpeg) {
            this.ffmpegPath = envFfmpeg;
        }

        const localYtdlpPath = this.getLocalYtdlpPath();
        if (envYtdlp) {
            this.ytdlpPath = envYtdlp;
        } else if (existsSync(localYtdlpPath)) {
            this.ytdlpPath = localYtdlpPath;
        }

        this.ffmpegAvailable = await this.checkBinary('FFmpeg', this.ffmpegPath, ['-version']);
        this.ytdlpAvailable = await this.checkBinary('yt-dlp', this.ytdlpPath, ['--version']);

        if (!this.ytdlpAvailable && !envYtdlp) {
            const downloaded = await this.downloadYtdlp(localYtdlpPath);
            if (downloaded) {
                this.ytdlpPath = localYtdlpPath;
                this.ytdlpAvailable = await this.checkBinary('yt-dlp', this.ytdlpPath, ['--version']);
            }
        }

        if (!this.ffmpegAvailable) {
            log.error('FFmpeg not found. Install it or set FFMPEG_PATH.');
        }

        if (!this.ytdlpAvailable) {
            log.error('yt-dlp not found. Install it or set YTDLP_PATH.');
        }

        return this.ffmpegAvailable && this.ytdlpAvailable;
    }

    private getLocalYtdlpPath(): string {
        const fileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        return join(config.paths.data, 'bin', fileName);
    }

    private async checkBinary(label: string, binaryPath: string, args: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            let output = '';
            let settled = false;

            const finish = (ok: boolean) => {
                if (!settled) {
                    settled = true;
                    resolve(ok);
                }
            };

            const child = spawn(binaryPath, args, {
                windowsHide: true,
                env: this.getSpawnEnv(),
            });

            child.stdout?.on('data', (data) => {
                output += data.toString();
            });

            child.stderr?.on('data', (data) => {
                output += data.toString();
            });

            child.on('error', (error) => {
                log.error(`${label} not found at ${binaryPath}`, error);
                finish(false);
            });

            child.on('close', (code) => {
                const success = code === 0;
                if (success) {
                    const trimmed = output.trim();
                    if (trimmed) {
                        const firstLine = trimmed.split(/\r?\n/)[0];
                        if (label.toLowerCase() === 'ffmpeg') {
                            const versionMatch = trimmed.match(/ffmpeg version ([^\s]+)/);
                            if (versionMatch) {
                                log.info(`FFmpeg found: version ${versionMatch[1]}`);
                            } else {
                                log.debug(`FFmpeg output: ${firstLine}`);
                            }
                        } else {
                            log.info(`${label} found: version ${firstLine}`);
                        }
                    }
                }
                finish(success);
            });
        });
    }

    private parseExtraArgs(rawArgs: string | undefined): string[] {
        if (!rawArgs) return [];
        const matches = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
        if (!matches) return [];
        return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ''));
    }

    private getScopedTrackKey(guildId: string, trackId: string): string {
        return `${guildId}:${trackId}`;
    }

    private getGuildCacheDir(guildId: string): string {
        return join(config.paths.cache, guildId);
    }

    private async ensureGuildCacheDir(guildId: string): Promise<string> {
        const guildCacheDir = this.getGuildCacheDir(guildId);
        await mkdir(guildCacheDir, { recursive: true });
        return guildCacheDir;
    }

    private async createRunDirectory(guildId: string): Promise<string> {
        const guildCacheDir = await this.ensureGuildCacheDir(guildId);
        const runDir = join(
            guildCacheDir,
            `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );
        await mkdir(runDir, { recursive: true });
        return runDir;
    }

    private getSpawnEnv(tempDir: string = config.paths.cache): NodeJS.ProcessEnv {
        return {
            ...process.env,
            TMPDIR: tempDir,
            TMP: tempDir,
            TEMP: tempDir,
            TEMPDIR: tempDir,
        };
    }

    private async cleanupRunDirectory(runDir: string): Promise<void> {
        try {
            await rm(runDir, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    }

    async cleanupGuildTemp(guildId: string): Promise<void> {
        const prefix = `${guildId}:`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
        for (const key of this.warmTracks.keys()) {
            if (key.startsWith(prefix)) {
                this.warmTracks.delete(key);
            }
        }
        for (const key of this.warmupInFlight.keys()) {
            if (key.startsWith(prefix)) {
                this.warmupInFlight.delete(key);
            }
        }

        const guildCacheDir = this.getGuildCacheDir(guildId);
        await rm(guildCacheDir, { recursive: true, force: true }).catch(() => undefined);
        await mkdir(guildCacheDir, { recursive: true }).catch(() => undefined);
        log.debug(`Cache temporaire nettoyé pour guild: ${guildId}`);
    }

    async cleanupAllStaleTemp(maxAgeMs: number = 6 * 60 * 60 * 1000): Promise<void> {
        try {
            await this.cleanupTempDir(config.paths.cache, maxAgeMs);
        } catch {
            // Ignore
        }
    }

    private async cleanupTempDir(dirPath: string, maxAgeMs: number): Promise<void> {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const now = Date.now();

        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                if (entry.name.startsWith('run-')) {
                    try {
                        const info = await stat(fullPath);
                        if (now - info.mtimeMs > maxAgeMs) {
                            await rm(fullPath, { recursive: true, force: true });
                        }
                    } catch {
                        // Ignore
                    }
                    continue;
                }

                await this.cleanupTempDir(fullPath, maxAgeMs).catch(() => undefined);
                continue;
            }

            if (/^--Frag\d+$/i.test(entry.name)) {
                await unlink(fullPath).catch(() => undefined);
            }
        }
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

    private isCookieCopyError(stderr: string): boolean {
        const lower = stderr.toLowerCase();
        return lower.includes('could not copy') && lower.includes('cookie');
    }

    private getYtdlpHint(stderr: string): string | null {
        const lower = stderr.toLowerCase();
        if (this.isCookieCopyError(stderr)) {
            return 'Impossible de copier la base de cookies du navigateur. Fermez Chrome/Edge ou utilisez YTDLP_COOKIES=chemin\\cookies.txt.';
        }
        if (lower.includes('http error 403') || lower.includes('forbidden')) {
            return 'yt-dlp recoit un 403. Essayez YTDLP_COOKIES_FROM_BROWSER=chrome (ou edge) ou YTDLP_COOKIES=chemin\\cookies.txt.';
        }
        if (lower.includes('sign in') || lower.includes('confirm you are not a bot')) {
            return 'YouTube demande une verification. Utilise des cookies via YTDLP_COOKIES_FROM_BROWSER ou YTDLP_COOKIES.';
        }
        return null;
    }

    private async waitForStreamReady(
        stream: NodeJS.ReadableStream | null | undefined,
        ytdlp: ChildProcess,
        ffmpeg: ChildProcess,
        timeoutMs: number
    ): Promise<'ready' | 'timeout' | 'ytdlp-close' | 'ffmpeg-close'> {
        return new Promise((resolve) => {
            let settled = false;
            let timer: NodeJS.Timeout;

            const finish = (result: 'ready' | 'timeout' | 'ytdlp-close' | 'ffmpeg-close') => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const onReady = () => {
                clearTimeout(timer);
                finish('ready');
            };
            const onYtdlpClose = () => {
                clearTimeout(timer);
                finish('ytdlp-close');
            };
            const onFfmpegClose = () => {
                clearTimeout(timer);
                finish('ffmpeg-close');
            };

            timer = setTimeout(() => {
                if (stream) {
                    stream.removeListener('data', onReady);
                }
                ytdlp.removeListener('close', onYtdlpClose);
                ffmpeg.removeListener('close', onFfmpegClose);
                finish('timeout');
            }, timeoutMs);

            if (stream) {
                stream.once('data', onReady);
            }
            ytdlp.once('close', onYtdlpClose);
            ffmpeg.once('close', onFfmpegClose);
        });
    }

    private async downloadYtdlp(targetPath: string): Promise<boolean> {
        try {
            const url = this.getYtdlpDownloadUrl();
            const binDir = join(config.paths.data, 'bin');
            await mkdir(binDir, { recursive: true });

            const tempPath = `${targetPath}.tmp`;

            log.info(`Downloading yt-dlp from ${url}`);

            const downloaded = await this.downloadFile(url, tempPath);

            if (!downloaded) {
                return false;
            }

            if (existsSync(targetPath)) {
                await unlink(targetPath);
            }

            await rename(tempPath, targetPath);

            if (process.platform !== 'win32') {
                await chmod(targetPath, 0o755);
            }

            log.info(`yt-dlp downloaded to: ${targetPath}`);
            return true;
        } catch (error) {
            log.error('yt-dlp download failed', error);
            return false;
        }
    }

    private async downloadFile(url: string, destination: string, redirectCount: number = 0): Promise<boolean> {
        const maxRedirects = 5;
        if (redirectCount > maxRedirects) {
            log.error('yt-dlp download failed: too many redirects');
            return false;
        }

        return new Promise((resolve) => {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const request = protocol.get(
                urlObj,
                { headers: { 'User-Agent': 'Mozilla/5.0' } },
                (response) => {
                    const statusCode = response.statusCode ?? 0;
                    const redirectStatuses = new Set([301, 302, 303, 307, 308]);

                    if (redirectStatuses.has(statusCode) && response.headers.location) {
                        const redirectUrl = new URL(response.headers.location, urlObj).toString();
                        response.resume();
                        resolve(this.downloadFile(redirectUrl, destination, redirectCount + 1));
                        return;
                    }

                    if (statusCode !== 200) {
                        log.error(`yt-dlp download failed with status ${statusCode}`);
                        response.resume();
                        resolve(false);
                        return;
                    }

                    const fileStream = createWriteStream(destination);
                    response.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close(() => resolve(true));
                    });

                    fileStream.on('error', (error) => {
                        log.error('yt-dlp download failed while writing file', error);
                        resolve(false);
                    });
                }
            );

            request.on('error', (error) => {
                log.error('yt-dlp download request failed', error);
                resolve(false);
            });
        });
    }

    private getYtdlpDownloadUrl(): string {
        if (process.platform === 'win32') {
            return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
        }
        return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    }

    /**
     * Crée une ressource audio à partir d'une piste
     * Utilise yt-dlp pour obtenir le stream audio
     */
    async createResource(guildId: string, track: Track, startSeconds: number = 0): Promise<AudioResource | null> {
        log.debug(`Création de ressource pour: ${track.title}`);
        log.trace('Track ID:', track.id);

        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            log.error('Audio dependencies not available, cannot create resource.');
            return null;
        }

        try {
            const cacheKey = this.getScopedTrackKey(guildId, track.id);
            const cached = this.cache.get(cacheKey);
            if (cached?.streamUrl && this.isLikelyDirectStreamUrl(cached.streamUrl)) {
                log.debug('Utilisation du stream audio pre-resolu en cache');
                const directResource = await this.createResourceWithDirectUrl(
                    guildId,
                    track,
                    cached.streamUrl,
                    startSeconds
                );
                if (directResource) {
                    return directResource;
                }
                log.debug('Fallback yt-dlp: stream direct invalide/expiré');
            }

            // Utiliser yt-dlp pour streamer directement
            log.debug('Utilisation de yt-dlp pour le streaming audio...');
            return await this.createResourceWithYtdlp(guildId, track, startSeconds);
        } catch (error) {
            log.error(`Erreur lors de la création de la ressource:`, error);
            return null;
        }
    }

    async createCrossfadeResource(
        guildId: string,
        currentTrack: Track,
        nextTrack: Track,
        currentOffsetSeconds: number,
        fadeSeconds: number
    ): Promise<AudioResource | null> {
        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            return null;
        }

        const currentUrl = await this.resolveDirectStreamUrl(guildId, currentTrack);
        const nextUrl = await this.resolveDirectStreamUrl(guildId, nextTrack);
        if (!currentUrl || !nextUrl) {
            log.warn('Crossfade impossible: URL directe manquante');
            return null;
        }

        const runDir = await this.createRunDirectory(guildId);
        const safeFade = Math.max(1, Math.min(Math.floor(fadeSeconds), 10));
        const safeOffset = Math.max(0, Math.floor(currentOffsetSeconds));

        const ffmpegArgs = [
            '-loglevel', 'warning',
            ...(safeOffset > 0 ? ['-ss', safeOffset.toString()] : []),
            '-i', currentUrl,
            '-i', nextUrl,
            '-filter_complex',
            `[0:a]aresample=48000,asetpts=PTS-STARTPTS[a0];` +
            `[1:a]aresample=48000,asetpts=PTS-STARTPTS[a1];` +
            `[a0][a1]acrossfade=d=${safeFade}:c1=tri:c2=tri[a]`,
            '-map', '[a]',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1',
        ];

        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.getSpawnEnv(runDir),
            cwd: runDir,
        });

        let tornDown = false;
        const teardown = (reason: string) => {
            if (tornDown) return;
            tornDown = true;
            log.trace(`Teardown crossfade pipeline: ${reason}`);

            try {
                ffmpeg.stdout?.destroy();
            } catch {
                // Ignore
            }

            try {
                ffmpeg.stderr?.destroy();
            } catch {
                // Ignore
            }

            if (!ffmpeg.killed) {
                try {
                    ffmpeg.kill();
                } catch {
                    // Ignore
                }
            }

            void this.cleanupRunDirectory(runDir);
        };

        let ffmpegErrors = '';
        ffmpeg.stderr?.on('data', (data) => {
            ffmpegErrors += data.toString();
        });

        ffmpeg.on('error', () => teardown('crossfade ffmpeg error'));
        ffmpeg.on('close', (code) => {
            if (code !== 0 && code !== null) {
                log.trace(`FFmpeg crossfade fermé avec code ${code}`);
            }
            teardown(`crossfade ffmpeg closed (${code ?? 'null'})`);
        });

        if (!ffmpeg.stdout) {
            teardown('crossfade stdout unavailable');
            return null;
        }

        const stdout = ffmpeg.stdout as Readable;
        stdout.once('close', () => teardown('crossfade audio stream closed'));
        stdout.once('end', () => teardown('crossfade audio stream ended'));
        stdout.once('error', () => teardown('crossfade audio stream error'));

        const resource = createAudioResource<ResourceMetadata>(stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true,
            metadata: {
                trackId: nextTrack.id,
                teardown: () => teardown('crossfade resource teardown requested'),
                createdAt: Date.now(),
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const ready = await this.waitForProcessStreamReady(stdout, ffmpeg, 1_500);
        if (ready === 'close') {
            if (ffmpegErrors) {
                log.trace('FFmpeg crossfade errors:', ffmpegErrors.slice(-500));
            }
            return null;
        }
        if (ready === 'timeout') {
            log.trace('FFmpeg crossfade readiness timeout, continuing');
        }

        return resource;
    }

    getDiscordOutputBitrateKbps(): number {
        return this.discordOpusBitrateKbps;
    }

    async getBestAudioBitrateKbps(url: string, guildId: string = 'global'): Promise<number | null> {
        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            return null;
        }

        const includeCookies = this.hasCookieEnv();
        const primary = await this.fetchYtdlpInfo(guildId, url, includeCookies);
        if (primary.info) {
            return this.extractAudioBitrateKbps(primary.info);
        }

        if (includeCookies && this.isCookieCopyError(primary.ytdlpErrors)) {
            const fallback = await this.fetchYtdlpInfo(guildId, url, false);
            if (fallback.info) {
                return this.extractAudioBitrateKbps(fallback.info);
            }
        }

        return null;
    }

    private async resolveDirectStreamUrl(guildId: string, track: Track): Promise<string | null> {
        const cacheKey = this.getScopedTrackKey(guildId, track.id);
        const cached = this.cache.get(cacheKey);
        if (cached?.streamUrl && this.isLikelyDirectStreamUrl(cached.streamUrl)) {
            return cached.streamUrl;
        }

        await this.warmTrack(guildId, track).catch(() => undefined);
        const afterWarm = this.cache.get(cacheKey);
        if (afterWarm?.streamUrl && this.isLikelyDirectStreamUrl(afterWarm.streamUrl)) {
            return afterWarm.streamUrl;
        }

        const includeCookies = this.hasCookieEnv();
        let infoResult = await this.fetchYtdlpInfo(guildId, track.url, includeCookies).catch(() => ({ info: null, ytdlpErrors: '' }));
        if (!infoResult.info && includeCookies && this.isCookieCopyError(infoResult.ytdlpErrors)) {
            infoResult = await this.fetchYtdlpInfo(guildId, track.url, false).catch(() => ({ info: null, ytdlpErrors: '' }));
        }

        const directUrl = infoResult.info ? this.extractBestAudioUrl(infoResult.info) : null;
        if (!directUrl) {
            return null;
        }

        this.cache.set(cacheKey, {
            guildId,
            trackId: track.id,
            resource: null,
            streamUrl: directUrl,
            timestamp: Date.now(),
        });
        return directUrl;
    }

    private isLikelyDirectStreamUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return false;
            }

            const host = parsed.hostname.toLowerCase();
            if (host.includes('googlevideo.com')) {
                return true;
            }

            return parsed.pathname.includes('.m4a') || parsed.pathname.includes('.webm');
        } catch {
            return false;
        }
    }

    private async waitForProcessStreamReady(
        stream: NodeJS.ReadableStream | null | undefined,
        processRef: ChildProcess,
        timeoutMs: number
    ): Promise<'ready' | 'timeout' | 'close'> {
        return new Promise((resolve) => {
            let settled = false;
            let timer: NodeJS.Timeout;

            const finish = (result: 'ready' | 'timeout' | 'close') => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const onReady = () => {
                clearTimeout(timer);
                finish('ready');
            };
            const onClose = () => {
                clearTimeout(timer);
                finish('close');
            };

            timer = setTimeout(() => {
                if (stream) {
                    stream.removeListener('data', onReady);
                }
                processRef.removeListener('close', onClose);
                finish('timeout');
            }, timeoutMs);

            if (stream) {
                stream.once('data', onReady);
            }
            processRef.once('close', onClose);
        });
    }

    private async createResourceWithDirectUrl(
        guildId: string,
        track: Track,
        directUrl: string,
        startSeconds: number
    ): Promise<AudioResource | null> {
        const runDir = await this.createRunDirectory(guildId);
        const ffmpegArgs = [
            '-loglevel', 'warning',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-probesize', '32k',
            '-analyzeduration', '0',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            ...(startSeconds > 0 ? ['-ss', startSeconds.toString()] : []),
            '-i', directUrl,
            '-vn',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1',
        ];

        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.getSpawnEnv(runDir),
            cwd: runDir,
        });

        let tornDown = false;
        const teardown = (reason: string) => {
            if (tornDown) {
                return;
            }
            tornDown = true;
            log.trace(`Teardown direct pipeline: ${reason}`);

            try {
                ffmpeg.stdout?.destroy();
            } catch {
                // Ignore
            }

            try {
                ffmpeg.stderr?.destroy();
            } catch {
                // Ignore
            }

            if (!ffmpeg.killed) {
                try {
                    ffmpeg.kill();
                } catch {
                    // Ignore
                }
            }
            void this.cleanupRunDirectory(runDir);
        };

        let ffmpegErrors = '';
        ffmpeg.stderr?.on('data', (data) => {
            ffmpegErrors += data.toString();
        });

        ffmpeg.on('error', () => {
            teardown('ffmpeg process error (direct)');
        });

        ffmpeg.on('close', (code) => {
            if (code !== 0 && code !== null) {
                log.trace(`FFmpeg direct fermé avec code ${code}`);
            }
            teardown(`ffmpeg direct closed (${code ?? 'null'})`);
        });

        if (!ffmpeg.stdout) {
            teardown('ffmpeg direct stdout unavailable');
            return null;
        }

        const stdout = ffmpeg.stdout as Readable;
        stdout.once('close', () => teardown('direct audio stream closed'));
        stdout.once('end', () => teardown('direct audio stream ended'));
        stdout.once('error', () => teardown('direct audio stream error'));

        const resource = createAudioResource<ResourceMetadata>(stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true,
            metadata: {
                trackId: track.id,
                teardown: () => teardown('direct resource teardown requested'),
                createdAt: Date.now(),
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const ready = await this.waitForProcessStreamReady(stdout, ffmpeg, 1_500);
        if (ready === 'close') {
            if (ffmpegErrors) {
                log.trace('FFmpeg direct errors:', ffmpegErrors.slice(-500));
            }
            return null;
        }
        if (ready === 'timeout') {
            log.trace('FFmpeg direct readiness timeout, fallback possible');
        }

        return resource;
    }

    /**
     * Crée une ressource audio en utilisant yt-dlp + FFmpeg
     */
    private async createResourceWithYtdlp(
        guildId: string,
        track: Track,
        startSeconds: number = 0
    ): Promise<AudioResource | null> {
        try {
            const includeCookies = this.hasCookieEnv();
            const primary = await this.createResourceWithYtdlpArgs(guildId, track, includeCookies, startSeconds);
            if (primary.resource) {
                return primary.resource;
            }

            if (includeCookies && this.isCookieCopyError(primary.ytdlpErrors)) {
                log.warn('yt-dlp cookies from browser failed, retrying without cookies');
                const fallback = await this.createResourceWithYtdlpArgs(guildId, track, false, startSeconds);
                return fallback.resource;
            }

            if (primary.ytdlpErrors) {
                log.error('yt-dlp errors:', primary.ytdlpErrors);
            }
            return null;
        } catch (error) {
            log.error('Erreur lors de la creation de la ressource avec yt-dlp:', error);
            return null;
        }
    }

    private async createResourceWithYtdlpArgs(
        guildId: string,
        track: Track,
        includeCookies: boolean,
        startSeconds: number
    ): Promise<{ resource: AudioResource | null; ytdlpErrors: string }> {
        log.debug(`Creation du stream avec yt-dlp (${includeCookies ? 'cookies' : 'no-cookies'})...`);
        log.trace('URL:', track.url);

        const runDir = await this.createRunDirectory(guildId);

        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        // Arguments yt-dlp pour extraire l'audio et l'envoyer vers stdout
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
            '--paths', `temp:${runDir}`,
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
            '-o', '-', // Output vers stdout
            '--quiet',
            track.url,
        ];

        log.trace('yt-dlp args:', ytdlpArgs.join(' '));

        const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.getSpawnEnv(runDir),
            cwd: runDir,
        });

        // Arguments FFmpeg pour transcoder en PCM
        const ffmpegArgs = [
            '-loglevel', 'warning',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-probesize', '32k',
            '-analyzeduration', '0',
            '-i', 'pipe:0', // Input depuis stdin (yt-dlp)
            '-vn', // Pas de video
            '-f', 's16le', // Format PCM
            '-ar', '48000', // Sample rate 48kHz
            '-ac', '2', // Stereo
            'pipe:1', // Output vers stdout
        ];

        log.trace('FFmpeg args:', ffmpegArgs.join(' '));

        const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.getSpawnEnv(runDir),
            cwd: runDir,
        });

        let tornDown = false;
        const teardown = (reason: string) => {
            if (tornDown) {
                return;
            }
            tornDown = true;
            log.trace(`Teardown audio pipeline: ${reason}`);

            try {
                ytdlp.stdout?.unpipe(ffmpeg.stdin!);
            } catch {
                // Ignore
            }

            try {
                ffmpeg.stdin?.destroy();
            } catch {
                // Ignore
            }

            try {
                ffmpeg.stdout?.destroy();
            } catch {
                // Ignore
            }

            try {
                ffmpeg.stderr?.destroy();
            } catch {
                // Ignore
            }

            if (!ffmpeg.killed) {
                try {
                    ffmpeg.kill();
                } catch {
                    // Ignore
                }
            }

            if (!ytdlp.killed) {
                try {
                    ytdlp.kill();
                } catch {
                    // Ignore
                }
            }
            void this.cleanupRunDirectory(runDir);
        };

        let pipeClosed = false;
        const handlePipeError = (label: string, error: NodeJS.ErrnoException) => {
            if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                pipeClosed = true;
                log.trace(`${label} closed`);
                return;
            }
            log.error(`${label} error:`, error);
        };

        ytdlp.stdout?.on('error', (error) => handlePipeError('yt-dlp stdout', error as NodeJS.ErrnoException));
        ffmpeg.stdin?.on('error', (error) => handlePipeError('FFmpeg stdin', error as NodeJS.ErrnoException));
        ffmpeg.stdout?.on('error', (error) => handlePipeError('FFmpeg stdout', error as NodeJS.ErrnoException));

        // Pipe yt-dlp stdout vers FFmpeg stdin
        ytdlp.stdout?.pipe(ffmpeg.stdin!);

        // Gérer les erreurs yt-dlp
        let ytdlpErrors = '';
        ytdlp.stderr?.on('data', (data) => {
            ytdlpErrors += data.toString();
        });

        ytdlp.on('error', (error) => {
            log.error('Erreur de processus yt-dlp:', error);
            teardown('yt-dlp process error');
        });

        ytdlp.on('spawn', () => {
            log.debug('yt-dlp démarré avec succès, PID:', ytdlp.pid);
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                log.debug('yt-dlp terminé normalement');
            } else if (code !== null) {
                log.warn(`yt-dlp terminé avec code: ${code}`);
                if (ytdlpErrors) {
                    log.error('Erreurs yt-dlp:', ytdlpErrors);
                    const hint = this.getYtdlpHint(ytdlpErrors);
                    if (hint) {
                        log.warn(hint);
                    }
                }
                teardown(`yt-dlp exited with code ${code}`);
            }
        });

        // Gérer les erreurs FFmpeg
        let ffmpegErrors = '';
        ffmpeg.stderr?.on('data', (data) => {
            const message = data.toString();
            ffmpegErrors += message;

            const lower = message.toLowerCase();
            const suppressed =
                lower.includes('error writing trailer') ||
                lower.includes('error muxing a packet') ||
                lower.includes('error closing file') ||
                lower.includes('error submitting a packet to the muxer') ||
                (pipeClosed && lower.includes('invalid argument'));

            if (suppressed) {
                log.trace('[FFmpeg]', message.trim());
                return;
            }

            if (message.includes('Stream') || message.includes('Output')) {
                log.trace('[FFmpeg]', message.trim());
            }

            if (lower.includes('error') || lower.includes('failed')) {
                log.error('[FFmpeg Error]', message.trim());
            }
        });

        ffmpeg.on('error', (error) => {
            log.error('Erreur de processus FFmpeg:', error);
            teardown('ffmpeg process error');
        });

        ffmpeg.on('spawn', () => {
            log.debug('FFmpeg démarré avec succès, PID:', ffmpeg.pid);
        });
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                log.debug('FFmpeg termine normalement');
            } else if (code !== null) {
                if (pipeClosed) {
                    log.trace(`FFmpeg termine apres fermeture du pipe: ${code}`);
                } else {
                    log.warn(`FFmpeg termine avec code: ${code}`);
                    if (ffmpegErrors) {
                        log.trace('Dernieres erreurs FFmpeg:', ffmpegErrors.slice(-500));
                    }
                }
            }
            teardown(`ffmpeg closed (${code ?? 'null'})`);
        });

        // Créer la ressource audio à partir du stdout de FFmpeg
        if (!ffmpeg.stdout) {
            log.error('FFmpeg stdout non disponible');
            teardown('ffmpeg stdout unavailable');
            return { resource: null, ytdlpErrors };
        }

        const stdout = ffmpeg.stdout as Readable;
        const stream = startSeconds > 0 ? this.createSkipStream(stdout, startSeconds) : stdout;
        const teardownOnStreamFinish = () => teardown('audio stream closed');
        stdout.once('close', teardownOnStreamFinish);
        stdout.once('end', teardownOnStreamFinish);
        stdout.once('error', teardownOnStreamFinish);
        if (stream !== stdout) {
            stream.once('close', teardownOnStreamFinish);
            stream.once('end', teardownOnStreamFinish);
            stream.once('error', teardownOnStreamFinish);
        }

        const resource = createAudioResource<ResourceMetadata>(stream, {
            inputType: StreamType.Raw, // PCM s16le
            inlineVolume: true,
            metadata: {
                trackId: track.id,
                teardown: () => teardown('resource teardown requested'),
                createdAt: Date.now(),
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const readyState = await this.waitForStreamReady(ytdlp.stdout, ytdlp, ffmpeg, this.streamReadyWaitMs);
        if (readyState === 'ytdlp-close' || readyState === 'ffmpeg-close') {
            log.warn(`yt-dlp stream ended before start (${readyState})`);
            teardown(`stream ended before ready (${readyState})`);
            return { resource: null, ytdlpErrors };
        }
        if (readyState === 'timeout') {
            log.debug('yt-dlp stream readiness timeout, continuing');
        }

        log.debug('AudioResource créée avec succès');
        return { resource, ytdlpErrors };
    }

    private createSkipStream(source: Readable, startSeconds: number): Readable {
        const bytesPerSecond = 48000 * 2 * 2;
        let remaining = Math.max(0, Math.floor(startSeconds * bytesPerSecond));

        const dropper = new Transform({
            transform(chunk, _encoding, callback) {
                if (remaining <= 0) {
                    this.push(chunk);
                    callback();
                    return;
                }

                if (chunk.length <= remaining) {
                    remaining -= chunk.length;
                    callback();
                    return;
                }

                const slice = chunk.subarray(remaining);
                remaining = 0;
                this.push(slice);
                callback();
            },
        });

        source.pipe(dropper);
        return dropper;
    }

    async warmTrack(guildId: string, track: Track): Promise<void> {
        const cacheKey = this.getScopedTrackKey(guildId, track.id);
        const existing = this.warmTracks.get(cacheKey);
        if (existing) {
            if (this.isWarmEntryExpired(existing)) {
                this.warmTracks.delete(cacheKey);
            } else {
                return;
            }
        }

        const pending = this.warmupInFlight.get(cacheKey);
        if (pending) {
            await pending;
            return;
        }

        const warmup = (async () => {
            const startedAt = Date.now();
            const includeCookies = this.hasCookieEnv();
            let infoResult = await this.fetchYtdlpInfo(guildId, track.url, includeCookies).catch(() => ({ info: null, ytdlpErrors: '' }));
            if (!infoResult.info && includeCookies && this.isCookieCopyError(infoResult.ytdlpErrors)) {
                infoResult = await this.fetchYtdlpInfo(guildId, track.url, false).catch(() => ({ info: null, ytdlpErrors: '' }));
            }

            const directUrl = infoResult.info ? this.extractBestAudioUrl(infoResult.info) : null;
            const existingCache = this.cache.get(cacheKey);
            this.cache.set(cacheKey, {
                guildId,
                trackId: track.id,
                resource: null,
                streamUrl: directUrl ?? existingCache?.streamUrl ?? track.url,
                timestamp: Date.now(),
            });

            this.warmTracks.set(cacheKey, {
                warmedAt: Date.now(),
                expiresAt: Date.now() + this.warmResourceTtlMs,
            });
            log.debug(
                `Warmup metadata prêt pour ${track.title} (${Date.now() - startedAt}ms, directUrl=${directUrl ? 'yes' : 'no'})`
            );
        })()
            .catch((error) => {
                log.trace(`Warmup échoué pour ${track.title}`, error);
            })
            .finally(() => {
                this.warmupInFlight.delete(cacheKey);
            });

        this.warmupInFlight.set(cacheKey, warmup);
        await warmup;
    }

    isTrackWarm(guildId: string, trackId: string): boolean {
        const cacheKey = this.getScopedTrackKey(guildId, trackId);
        const entry = this.warmTracks.get(cacheKey);
        if (!entry) {
            return false;
        }

        if (this.isWarmEntryExpired(entry)) {
            this.warmTracks.delete(cacheKey);
            return false;
        }

        return true;
    }

    clearWarmResource(guildId: string, trackId: string): void {
        const cacheKey = this.getScopedTrackKey(guildId, trackId);
        if (!this.warmTracks.has(cacheKey)) {
            return;
        }
        this.warmTracks.delete(cacheKey);
    }

    teardownResource(resource: AudioResource | null | undefined): void {
        if (!resource) {
            return;
        }

        const metadata = resource.metadata as Partial<ResourceMetadata> | undefined;
        if (metadata && typeof metadata.teardown === 'function') {
            try {
                metadata.teardown();
            } catch (error) {
                log.trace('Erreur lors du teardown explicite de la ressource', error);
            }
        }
    }

    private isWarmEntryExpired(entry: WarmResourceEntry): boolean {
        return Date.now() > entry.expiresAt;
    }

    private async fetchYtdlpInfo(
        guildId: string,
        url: string,
        includeCookies: boolean
    ): Promise<{ info: any | null; ytdlpErrors: string }> {
        const runDir = await this.createRunDirectory(guildId);
        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
            '--paths', `temp:${runDir}`,
            '--skip-download',
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
            '--dump-single-json',
            url,
        ];

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: this.getSpawnEnv(runDir),
                cwd: runDir,
            });

            ytdlp.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('error', (error) => {
                log.error('yt-dlp info error:', error);
                void this.cleanupRunDirectory(runDir);
                resolve({ info: null, ytdlpErrors: stderr });
            });

            ytdlp.on('close', (code) => {
                void this.cleanupRunDirectory(runDir);
                if (code !== 0) {
                    if (stderr) {
                        log.trace('yt-dlp info errors:', stderr.trim());
                    }
                    resolve({ info: null, ytdlpErrors: stderr });
                    return;
                }

                const payload = stdout.trim();
                if (!payload) {
                    resolve({ info: null, ytdlpErrors: stderr });
                    return;
                }

                try {
                    const info = JSON.parse(payload);
                    resolve({ info, ytdlpErrors: stderr });
                } catch (error) {
                    log.warn('Impossible de parser les infos yt-dlp');
                    resolve({ info: null, ytdlpErrors: stderr });
                }
            });
        });
    }

    private extractAudioBitrateKbps(info: any): number | null {
        const direct = this.normalizeBitrate(info?.abr ?? info?.tbr ?? info?.audio_bitrate);
        if (direct) {
            return direct;
        }

        const formats = Array.isArray(info?.formats) ? info.formats : [];
        const audioFormats = formats.filter((format: any) =>
            format &&
            format.acodec &&
            format.acodec !== 'none' &&
            (format.vcodec === 'none' || !format.vcodec)
        );

        let best: number | null = null;
        for (const format of audioFormats) {
            const value = this.normalizeBitrate(format.abr ?? format.tbr ?? format.audio_bitrate);
            if (value && (best === null || value > best)) {
                best = value;
            }
        }

        return best;
    }

    private extractBestAudioUrl(info: any): string | null {
        const topLevel = typeof info?.url === 'string' ? info.url : null;
        if (topLevel && this.isLikelyDirectStreamUrl(topLevel)) {
            return topLevel;
        }

        const requested = Array.isArray(info?.requested_downloads) ? info.requested_downloads : [];
        for (const item of requested) {
            if (typeof item?.url === 'string' && this.isLikelyDirectStreamUrl(item.url)) {
                return item.url;
            }
        }

        const formats = Array.isArray(info?.formats) ? info.formats : [];
        const audioFormats = formats
            .filter((format: any) =>
                format &&
                typeof format.url === 'string' &&
                format.acodec &&
                format.acodec !== 'none' &&
                (format.vcodec === 'none' || !format.vcodec)
            )
            .sort((a: any, b: any) => {
                const aBitrate = this.normalizeBitrate(a.abr ?? a.tbr ?? a.audio_bitrate) ?? 0;
                const bBitrate = this.normalizeBitrate(b.abr ?? b.tbr ?? b.audio_bitrate) ?? 0;
                return bBitrate - aBitrate;
            });

        const best = audioFormats.find((format: any) => this.isLikelyDirectStreamUrl(format.url));
        return best?.url ?? null;
    }

    private normalizeBitrate(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.round(value);
        }
        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed)) {
                return Math.round(parsed);
            }
        }
        return null;
    }


    /**
     * Pré-charge les prochaines pistes (avec yt-dlp, on vérifie juste que les URLs sont valides)
     */
    async preloadTracks(guildId: string, tracks: Track[]): Promise<void> {
        if (this.preloadingGuilds.has(guildId)) {
            log.trace(`Pré-chargement déjà en cours (${guildId}), ignoré`);
            return;
        }

        this.preloadingGuilds.add(guildId);
        try {
            const toPreload = tracks.slice(0, config.audio.cacheAhead);
            log.debug(`Pré-vérification de ${toPreload.length} piste(s)...`);

            for (const track of toPreload) {
                const cacheKey = this.getScopedTrackKey(guildId, track.id);
                if (this.cache.has(cacheKey)) {
                    log.trace(`Déjà vérifié: ${track.title}`);
                    continue;
                }

                try {
                    log.trace(`Pré-vérification: ${track.title}`);

                    // Avec yt-dlp, on met juste en cache l'ID pour savoir qu'on l'a vérifié
                    this.cache.set(cacheKey, {
                        guildId,
                        trackId: track.id,
                        resource: null,
                        streamUrl: track.url,
                        timestamp: Date.now(),
                    });
                    log.info(`Pré-vérifié: ${track.title}`);
                } catch (error) {
                    log.error(`Erreur de pré-vérification pour ${track.title}:`, error);
                }
            }
        } finally {
            this.preloadingGuilds.delete(guildId);
        }
        log.debug('Pré-vérification terminée');
    }

    /**
     * Nettoie le cache périodiquement
     */
    private startCacheCleanup(): void {
        setInterval(() => {
            const now = Date.now();
            const maxAge = 30 * 60 * 1000; // 30 minutes
            let cleaned = 0;
            let warmCleaned = 0;

            for (const [trackId, entry] of this.cache.entries()) {
                if (now - entry.timestamp > maxAge) {
                    this.cache.delete(trackId);
                    cleaned++;
                }
            }

            for (const [trackId, entry] of this.warmTracks.entries()) {
                if (now > entry.expiresAt) {
                    this.warmTracks.delete(trackId);
                    warmCleaned++;
                }
            }

            if (cleaned > 0) {
                log.debug(`Nettoyage du cache: ${cleaned} entrée(s) supprimée(s)`);
            }
            if (warmCleaned > 0) {
                log.debug(`Nettoyage warmup: ${warmCleaned} entrée(s) supprimée(s)`);
            }
            void this.cleanupAllStaleTemp();
        }, 5 * 60 * 1000); // Vérifier toutes les 5 minutes
    }

    /**
     * Supprime une entrée du cache
     */
    clearFromCache(guildId: string, trackId: string): void {
        const cacheKey = this.getScopedTrackKey(guildId, trackId);
        if (this.cache.delete(cacheKey)) {
            log.trace(`Supprimé du cache: ${cacheKey}`);
        }
        this.clearWarmResource(guildId, trackId);
    }

    /**
     * Vide tout le cache
     */
    clearCache(): void {
        const size = this.cache.size;
        const warmSize = this.warmTracks.size;
        const inFlightSize = this.warmupInFlight.size;
        this.cache.clear();
        this.warmTracks.clear();
        this.warmupInFlight.clear();
        this.preloadingGuilds.clear();
        log.info(`Cache vidé: ${size} entrée(s) supprimée(s), warmup vidé: ${warmSize}, warmup in-flight: ${inFlightSize}`);
    }

    /**
     * Obtient la taille du cache
     */
    getCacheSize(): number {
        return this.cache.size;
    }
}

export const audioWrapper = new AudioWrapper();
