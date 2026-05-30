import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Transform } from 'stream';
import type { ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { mkdir, chmod, rename, unlink, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { createAudioResource, StreamType, AudioResource } from '@discordjs/voice';
import type { Track } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import { downloadFile } from '../utils/httpClient.js';
import { sanitizeUrlForLogs } from '../utils/networkSafety.js';
import { mediaCacheManager } from './MediaCacheManager.js';
import { sponsorBlockService } from './SponsorBlockService.js';

const log = logger.createModuleLogger('AudioWrapper');

const SAFE_CHILD_ENV_KEYS = [
    'APPDATA',
    'ComSpec',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'NODE_EXTRA_CA_CERTS',
    'NO_PROXY',
    'PATH',
    'PATHEXT',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'SystemRoot',
    'TZ',
    'USERPROFILE',
    'WINDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
    'http_proxy',
    'https_proxy',
    'no_proxy',
] as const;

const REDACTED_YTDLP_FLAGS = new Set([
    '--add-header',
    '--ap-password',
    '--ap-username',
    '--cookies',
    '--cookies-from-browser',
    '--http-header',
    '--netrc-cmd',
    '--password',
    '--proxy',
    '--username',
    '--video-password',
]);

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
    startSeconds: number;
}

interface WarmResourceEntry {
    warmedAt: number;
    expiresAt: number;
}

interface SponsorSegment {
    start: number;
    end: number;
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
    private lastSourceModeByGuild: Map<string, 'direct' | 'ytdlp' | 'unknown'> = new Map();
    private readonly discordOpusBitrateKbps = 96;
    private readonly streamReadyWaitMs = 1_000;
    private readonly directStreamReadyWaitMs = 1_000;
    private readonly crossfadeReadyWaitMs = 4_000;
    private readonly warmResourceTtlMs = 90_000;
    private warnedUnsafeYtdlpExtraArgsIgnored = false;

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

        if (!this.ytdlpAvailable && !envYtdlp && config.audio.ytdlpAutoDownload) {
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
            if (config.audio.ytdlpAutoDownload) {
                log.error('yt-dlp not found. Install it or set YTDLP_PATH.');
            } else {
                log.error('yt-dlp not found. Install it, set YTDLP_PATH, or enable YTDLP_AUTO_DOWNLOAD=true.');
            }
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
        const safeEnv: NodeJS.ProcessEnv = {};

        for (const key of SAFE_CHILD_ENV_KEYS) {
            const value = process.env[key];
            if (value) {
                safeEnv[key] = value;
            }
        }

        safeEnv.TMPDIR = tempDir;
        safeEnv.TMP = tempDir;
        safeEnv.TEMP = tempDir;
        safeEnv.TEMPDIR = tempDir;

        return safeEnv;
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

        this.lastSourceModeByGuild.delete(guildId);
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
        const extraArgs = this.getUnsafeYtdlpExtraArgs();
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
        const extraArgs = this.getUnsafeYtdlpExtraArgs();

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
            log.warn('YTDLP_EXTRA_ARGS ignored. Set YTDLP_ALLOW_UNSAFE_EXTRA_ARGS=true only if you fully trust the server environment.');
        }

        return [];
    }

    private sanitizeYtdlpArgsForLogs(args: string[]): string {
        const sanitized: string[] = [];

        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index];
            const equalsIndex = arg.indexOf('=');
            const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;

            if (REDACTED_YTDLP_FLAGS.has(flag)) {
                if (equalsIndex >= 0) {
                    sanitized.push(`${flag}=[redacted]`);
                } else {
                    sanitized.push(flag);
                    if (index + 1 < args.length) {
                        sanitized.push('[redacted]');
                        index += 1;
                    }
                }
                continue;
            }

            sanitized.push(arg);
        }

        return sanitized.join(' ');
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

            const cleanup = () => {
                if (stream) {
                    stream.removeListener('readable', onReady);
                }
                ytdlp.removeListener('close', onYtdlpClose);
                ffmpeg.removeListener('close', onFfmpegClose);
            };

            const onReady = () => {
                clearTimeout(timer);
                cleanup();
                finish('ready');
            };
            const onYtdlpClose = () => {
                clearTimeout(timer);
                cleanup();
                finish('ytdlp-close');
            };
            const onFfmpegClose = () => {
                clearTimeout(timer);
                cleanup();
                finish('ffmpeg-close');
            };

            timer = setTimeout(() => {
                cleanup();
                finish('timeout');
            }, timeoutMs);

            if (stream && typeof (stream as Readable).readableLength === 'number' && (stream as Readable).readableLength > 0) {
                queueMicrotask(onReady);
                return;
            }

            if (stream) {
                stream.once('readable', onReady);
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
            await downloadFile(url, tempPath, ['github.com', 'objects.githubusercontent.com']);

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
    async createResource(
        guildId: string,
        track: Track,
        startSeconds: number = 0,
        sponsorBlockEnabled = false,
        targetVolume = 100
    ): Promise<AudioResource | null> {
        log.debug(`Création de ressource pour: ${track.title}`);
        log.trace('Track ID:', track.id);

        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            log.error('Audio dependencies not available, cannot create resource.');
            return null;
        }

        try {
            const sponsorSegments = await this.getSponsorSegmentsFast(track.id, sponsorBlockEnabled);
            this.applySponsorAdjustedDuration(track, sponsorSegments);
            const effectiveStartSeconds = this.getSponsorAdjustedStart(startSeconds, sponsorSegments);
            if (effectiveStartSeconds > startSeconds + 0.25) {
                log.info(`SponsorBlock: saut du debut non musical jusqu'a ${effectiveStartSeconds.toFixed(1)}s`);
            }

            const cachedFile = await mediaCacheManager.getTrackPath(track.id);
            if (cachedFile) {
                const resource = await this.createResourceWithDirectUrl(
                    guildId,
                    track,
                    cachedFile,
                    effectiveStartSeconds,
                    sponsorSegments,
                    targetVolume
                );
                if (resource) {
                    this.lastSourceModeByGuild.set(guildId, 'direct');
                    return resource;
                }
            }

            const cacheKey = this.getScopedTrackKey(guildId, track.id);
            const cached = this.cache.get(cacheKey);
            if (cached?.streamUrl && this.isLikelyDirectStreamUrl(cached.streamUrl)) {
                log.debug('Utilisation du stream audio pre-resolu en cache');
                const directResource = await this.createResourceWithDirectUrl(
                    guildId,
                    track,
                    cached.streamUrl,
                    effectiveStartSeconds,
                    sponsorSegments,
                    targetVolume
                );
                if (directResource) {
                    this.lastSourceModeByGuild.set(guildId, 'direct');
                    return directResource;
                }
                log.debug('Fallback yt-dlp: stream direct invalide/expiré');
            }

            const shouldPreferDirectUrl = track.sourceType === 'url' || effectiveStartSeconds > startSeconds + 3;
            const warmDirectUrl = await this.waitForWarmDirectUrl(guildId, track, shouldPreferDirectUrl ? 8_000 : 1_500);
            if (warmDirectUrl) {
                const directResource = await this.createResourceWithDirectUrl(
                    guildId,
                    track,
                    warmDirectUrl,
                    effectiveStartSeconds,
                    sponsorSegments,
                    targetVolume
                );
                if (directResource) {
                    this.lastSourceModeByGuild.set(guildId, 'direct');
                    return directResource;
                }
            }

            if (shouldPreferDirectUrl && !this.warmupInFlight.has(cacheKey)) {
                const seekableUrl = await this.resolveDirectStreamUrlQuick(guildId, track, track.sourceType === 'url' ? 10_000 : 6_000);
                if (seekableUrl) {
                    const directResource = await this.createResourceWithDirectUrl(
                        guildId,
                        track,
                        seekableUrl,
                        effectiveStartSeconds,
                        sponsorSegments,
                        targetVolume
                    );
                    if (directResource) {
                        this.lastSourceModeByGuild.set(guildId, 'direct');
                        return directResource;
                    }
                }
            }

            if (track.sourceType === 'url') {
                log.warn(`URL YouTube non lisible ou indisponible: ${track.id}`);
                this.lastSourceModeByGuild.set(guildId, 'unknown');
                return null;
            }

            log.debug('Aucun media pre-resolu disponible, demarrage streaming yt-dlp immediat');
            const fallback = await this.createResourceWithYtdlp(guildId, track, effectiveStartSeconds, sponsorSegments);
            this.lastSourceModeByGuild.set(guildId, fallback ? 'ytdlp' : 'unknown');
            return fallback;
        } catch (error) {
            log.error(`Erreur lors de la création de la ressource:`, error);
            return null;
        }
    }

    private async getSponsorSegmentsFast(videoId: string, enabled: boolean): Promise<SponsorSegment[]> {
        if (!enabled) {
            return [];
        }

        return Promise.race([
            sponsorBlockService.getSegments(videoId, enabled),
            new Promise<SponsorSegment[]>((resolve) => {
                const timer = setTimeout(() => resolve([]), 2_500);
                timer.unref?.();
            }),
        ]);
    }

    private async waitForWarmDirectUrl(guildId: string, track: Track, timeoutMs: number): Promise<string | null> {
        const cacheKey = this.getScopedTrackKey(guildId, track.id);
        if (!this.warmupInFlight.has(cacheKey)) {
            return null;
        }

        await Promise.race([
            this.warmupInFlight.get(cacheKey),
            new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs);
                timer.unref?.();
            }),
        ]);

        const warmed = this.cache.get(cacheKey);
        return warmed?.streamUrl && this.isLikelyDirectStreamUrl(warmed.streamUrl) ? warmed.streamUrl : null;
    }

    private getSponsorAdjustedStart(startSeconds: number, sponsorSegments: SponsorSegment[]): number {
        let adjustedStart = Math.max(0, startSeconds);
        const segments = this.normalizeSponsorSegments(sponsorSegments);

        for (const segment of segments) {
            if (segment.start <= adjustedStart + 1 && segment.end > adjustedStart + 0.3) {
                adjustedStart = segment.end;
                continue;
            }

            if (segment.start > adjustedStart + 1) {
                break;
            }
        }

        return adjustedStart;
    }

    private applySponsorAdjustedDuration(track: Track, sponsorSegments: SponsorSegment[]): void {
        if (sponsorSegments.length === 0 || !Number.isFinite(track.duration) || track.duration <= 0) {
            return;
        }

        const originalDuration = track.originalDuration ?? track.duration;
        if (!Number.isFinite(originalDuration) || originalDuration <= 0) {
            return;
        }

        const skippedDuration = this.getSponsorSkippedDuration(originalDuration, sponsorSegments);
        if (skippedDuration <= 0.3) {
            return;
        }

        track.originalDuration = originalDuration;
        track.duration = Math.max(1, Math.round(originalDuration - skippedDuration));
        log.debug(`SponsorBlock: duree ajustee ${Math.round(originalDuration)}s -> ${track.duration}s`);
    }

    private getSponsorSkippedDuration(durationSeconds: number, sponsorSegments: SponsorSegment[]): number {
        const clipped = this.normalizeSponsorSegments(sponsorSegments)
            .map((segment) => ({
                start: Math.max(0, Math.min(durationSeconds, segment.start)),
                end: Math.max(0, Math.min(durationSeconds, segment.end)),
            }))
            .filter((segment) => segment.end > segment.start + 0.3);

        return clipped.reduce((total, segment) => total + (segment.end - segment.start), 0);
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
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            ...(safeOffset > 0 ? ['-ss', safeOffset.toString()] : []),
            '-i', currentUrl,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
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
                startSeconds: 0,
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const ready = await this.waitForProcessStreamReady(stdout, ffmpeg, this.crossfadeReadyWaitMs);
        if (ready === 'close') {
            if (ffmpegErrors) {
                log.trace('FFmpeg crossfade errors:', ffmpegErrors.slice(-500));
            }
            return null;
        }
        if (ready === 'timeout') {
            log.trace('FFmpeg crossfade readiness timeout, fallback possible');
            teardown('crossfade readiness timeout');
            return null;
        }

        return resource;
    }

    getDiscordOutputBitrateKbps(): number {
        return this.discordOpusBitrateKbps;
    }

    getLastSourceMode(guildId: string): 'direct' | 'ytdlp' | 'unknown' {
        return this.lastSourceModeByGuild.get(guildId) ?? 'unknown';
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

        const quickUrl = await this.resolveDirectStreamUrlQuick(guildId, track, 8_000);
        if (quickUrl) {
            return quickUrl;
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

    private async resolveDirectStreamUrlQuick(guildId: string, track: Track, timeoutMs: number): Promise<string | null> {
        const cacheKey = this.getScopedTrackKey(guildId, track.id);
        const cached = this.cache.get(cacheKey);
        if (cached?.streamUrl && this.isLikelyDirectStreamUrl(cached.streamUrl)) {
            return cached.streamUrl;
        }

        const inFlight = this.warmupInFlight.get(cacheKey);
        if (inFlight) {
            await Promise.race([
                inFlight,
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, timeoutMs);
                    timer.unref?.();
                }),
            ]);

            const warmed = this.cache.get(cacheKey);
            if (warmed?.streamUrl && this.isLikelyDirectStreamUrl(warmed.streamUrl)) {
                return warmed.streamUrl;
            }
            if (this.warmupInFlight.has(cacheKey)) {
                return null;
            }
        }

        const includeCookies = this.hasCookieEnv();
        const attempts = includeCookies ? [true, false] : [false];
        for (const attemptCookies of attempts) {
            const result = await this.fetchDirectStreamUrl(guildId, track.url, attemptCookies, timeoutMs);
            if (result.url) {
                this.cache.set(cacheKey, {
                    guildId,
                    trackId: track.id,
                    resource: null,
                    streamUrl: result.url,
                    timestamp: Date.now(),
                });
                return result.url;
            }

            if (!attemptCookies || !this.isCookieCopyError(result.ytdlpErrors)) {
                break;
            }
        }

        return null;
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

            const cleanup = () => {
                if (stream) {
                    stream.removeListener('readable', onReady);
                }
                processRef.removeListener('close', onClose);
            };

            const onReady = () => {
                clearTimeout(timer);
                cleanup();
                finish('ready');
            };
            const onClose = () => {
                clearTimeout(timer);
                cleanup();
                finish('close');
            };

            timer = setTimeout(() => {
                cleanup();
                finish('timeout');
            }, timeoutMs);

            if (stream && typeof (stream as Readable).readableLength === 'number' && (stream as Readable).readableLength > 0) {
                queueMicrotask(onReady);
                return;
            }

            if (stream) {
                stream.once('readable', onReady);
            }
            processRef.once('close', onClose);
        });
    }

    private async createResourceWithDirectUrl(
        guildId: string,
        track: Track,
        directUrl: string,
        startSeconds: number,
        sponsorSegments: SponsorSegment[] = [],
        targetVolume = 100
    ): Promise<AudioResource | null> {
        const runDir = await this.createRunDirectory(guildId);
        const filters = this.buildAudioFilters(startSeconds, sponsorSegments);
        const useOpusCopy = this.canCopyDirectOpus(directUrl, filters, targetVolume);
        const inputReconnectArgs = /^https?:\/\//i.test(directUrl)
            ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2']
            : [];
        const outputArgs = useOpusCopy
            ? ['-map', '0:a:0', '-c:a', 'copy', '-f', 'ogg']
            : [
                ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
            ];
        const ffmpegArgs = [
            '-loglevel', 'warning',
            ...inputReconnectArgs,
            ...(startSeconds > 0 ? ['-ss', startSeconds.toString()] : []),
            '-i', directUrl,
            '-vn',
            ...outputArgs,
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
            inputType: useOpusCopy ? StreamType.OggOpus : StreamType.Raw,
            inlineVolume: !useOpusCopy,
            metadata: {
                trackId: track.id,
                teardown: () => teardown('direct resource teardown requested'),
                createdAt: Date.now(),
                startSeconds,
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const ready = await this.waitForProcessStreamReady(stdout, ffmpeg, this.directStreamReadyWaitMs);
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

    private canCopyDirectOpus(directUrl: string, filters: string[], targetVolume: number): boolean {
        if (filters.length > 0 || Math.round(targetVolume) !== 100) {
            return false;
        }

        try {
            const decoded = decodeURIComponent(directUrl);
            return /mime=audio\/(?:webm|ogg)/i.test(decoded);
        } catch {
            return /mime=audio\/(?:webm|ogg)/i.test(directUrl);
        }
    }

    private buildAudioFilters(startSeconds: number, sponsorSegments: SponsorSegment[]): string[] {
        const filters: string[] = [];
        const normalizedStart = Math.max(0, startSeconds);
        const shiftedSegments = this.shiftSponsorSegments(sponsorSegments, normalizedStart);
        const sponsorFilter = this.buildSponsorFilter(shiftedSegments);
        if (sponsorFilter) {
            filters.push(`aselect='${sponsorFilter}'`);
        }

        if (filters.length > 0) {
            filters.push('asetpts=N/SR/TB');
        }

        return filters;
    }

    private buildSponsorFilter(segments: SponsorSegment[]): string | null {
        const normalized = this.normalizeSponsorSegments(segments);
        if (normalized.length === 0) {
            return null;
        }

        return `not((${normalized.map((segment) => `between(t,${segment.start},${segment.end})`).join('+')}))`;
    }

    private shiftSponsorSegments(segments: SponsorSegment[], startSeconds: number): SponsorSegment[] {
        if (startSeconds <= 0) {
            return segments;
        }

        return segments
            .map((segment) => ({
                start: Math.max(0, segment.start - startSeconds),
                end: segment.end - startSeconds,
            }))
            .filter((segment) => segment.end > segment.start + 0.3);
    }

    private normalizeSponsorSegments(segments: SponsorSegment[]): SponsorSegment[] {
        const cleaned = segments
            .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
            .map((segment) => ({
                start: Math.max(0, Number.parseFloat(segment.start.toFixed(3))),
                end: Math.max(0, Number.parseFloat(segment.end.toFixed(3))),
            }))
            .filter((segment) => segment.end > segment.start + 0.3)
            .sort((a, b) => a.start - b.start);

        const merged: SponsorSegment[] = [];
        for (const segment of cleaned) {
            const last = merged[merged.length - 1];
            if (!last || segment.start > last.end + 0.3) {
                merged.push({ ...segment });
            } else {
                last.end = Math.max(last.end, segment.end);
            }
        }

        return merged;
    }

    /**
     * Crée une ressource audio en utilisant yt-dlp + FFmpeg
     */
    private async createResourceWithYtdlp(
        guildId: string,
        track: Track,
        startSeconds: number = 0,
        sponsorSegments: SponsorSegment[] = []
    ): Promise<AudioResource | null> {
        try {
            const includeCookies = this.hasCookieEnv();
            const primary = await this.createResourceWithYtdlpArgs(guildId, track, includeCookies, startSeconds, sponsorSegments);
            if (primary.resource) {
                return primary.resource;
            }

            if (includeCookies && this.isCookieCopyError(primary.ytdlpErrors)) {
                log.warn('yt-dlp cookies from browser failed, retrying without cookies');
                const fallback = await this.createResourceWithYtdlpArgs(guildId, track, false, startSeconds, sponsorSegments);
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
        startSeconds: number,
        sponsorSegments: SponsorSegment[]
    ): Promise<{ resource: AudioResource | null; ytdlpErrors: string }> {
        log.debug(`Creation du stream avec yt-dlp (${includeCookies ? 'cookies' : 'no-cookies'})...`);
        log.trace('URL:', sanitizeUrlForLogs(track.url));

        const runDir = await this.createRunDirectory(guildId);

        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        // Arguments yt-dlp pour extraire l'audio et l'envoyer vers stdout
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
            '--paths', `temp:${runDir}`,
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
            '-o', '-', // Output vers stdout
            '--quiet',
            track.url,
        ];

        log.trace('yt-dlp args:', this.sanitizeYtdlpArgsForLogs(ytdlpArgs));

        const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: this.getSpawnEnv(runDir),
            cwd: runDir,
        });

        const filteredSponsorSegments = sponsorSegments.filter((segment) => segment.end > startSeconds + 0.3);
        const filters = this.buildAudioFilters(0, filteredSponsorSegments);
        // Arguments FFmpeg pour transcoder en PCM
        const ffmpegArgs = [
            '-loglevel', 'warning',
            '-i', 'pipe:0', // Input depuis stdin (yt-dlp)
            '-vn', // Pas de video
            ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
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
                startSeconds,
            },
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const readyState = await this.waitForStreamReady(stream, ytdlp, ffmpeg, this.streamReadyWaitMs);
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
            let streamResult = await this.fetchDirectStreamUrl(guildId, track.url, includeCookies, 15_000)
                .catch(() => ({ url: null, ytdlpErrors: '' }));
            if (!streamResult.url && includeCookies && this.isCookieCopyError(streamResult.ytdlpErrors)) {
                streamResult = await this.fetchDirectStreamUrl(guildId, track.url, false, 15_000)
                    .catch(() => ({ url: null, ytdlpErrors: '' }));
            }

            const directUrl = streamResult.url;
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

    private async fetchDirectStreamUrl(
        guildId: string,
        url: string,
        includeCookies: boolean,
        timeoutMs: number
    ): Promise<{ url: string | null; ytdlpErrors: string }> {
        const runDir = await this.createRunDirectory(guildId);
        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
            '--paths', `temp:${runDir}`,
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
            '--get-url',
            url,
        ];

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: this.getSpawnEnv(runDir),
                cwd: runDir,
            });

            const finish = (resultUrl: string | null, errors: string = stderr) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                void this.cleanupRunDirectory(runDir);
                resolve({ url: resultUrl, ytdlpErrors: errors });
            };

            const timer = setTimeout(() => {
                if (!ytdlp.killed) {
                    ytdlp.kill();
                }
                finish(null, stderr || `yt-dlp get-url timeout after ${timeoutMs}ms`);
            }, timeoutMs);
            timer.unref?.();

            ytdlp.stdout?.on('data', (data) => {
                stdout += data.toString();
                const directUrl = this.findDirectStreamUrl(stdout);
                if (directUrl) {
                    if (!ytdlp.killed) {
                        ytdlp.kill();
                    }
                    finish(directUrl);
                }
            });

            ytdlp.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('error', (error) => {
                finish(null, `${stderr}\n${error.message}`.trim());
            });

            ytdlp.on('close', (code) => {
                if (code !== 0) {
                    finish(null, stderr);
                    return;
                }

                const directUrl = this.findDirectStreamUrl(stdout);
                finish(directUrl ?? null, stderr);
            });
        });
    }

    private findDirectStreamUrl(output: string): string | null {
        return output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => this.isLikelyDirectStreamUrl(line)) ?? null;
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
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
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
            mediaCacheManager.preloadTracks(toPreload);

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
        const timer = setInterval(() => {
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
        timer.unref();
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
        this.lastSourceModeByGuild.clear();
        mediaCacheManager.clearAll();
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
