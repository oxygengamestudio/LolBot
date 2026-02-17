import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Transform } from 'stream';
import type { ChildProcess } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, chmod, rename, unlink } from 'fs/promises';
import { join } from 'path';
import http from 'http';
import https from 'https';
import { createAudioResource, StreamType, AudioResource } from '@discordjs/voice';
import type { Track } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('AudioWrapper');

interface CacheEntry {
    trackId: string;
    resource: AudioResource | null;
    streamUrl: string | null;
    timestamp: number;
}

export class AudioWrapper extends EventEmitter {
    private cache: Map<string, CacheEntry> = new Map();
    private preloadQueue: Track[] = [];
    private isPreloading: boolean = false;
    private ffmpegPath: string = 'ffmpeg';
    private ytdlpPath: string = 'yt-dlp';
    private ffmpegAvailable: boolean = false;
    private ytdlpAvailable: boolean = false;
    private dependenciesReady: Promise<boolean> | null = null;
    private readonly discordOpusBitrateKbps = 128;

    constructor() {
        super();
        log.info('AudioWrapper initialisé');
        this.dependenciesReady = this.checkDependencies();
        this.startCacheCleanup();
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

            const child = spawn(binaryPath, args, { windowsHide: true });

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
    async createResource(track: Track, startSeconds: number = 0): Promise<AudioResource | null> {
        log.debug(`Création de ressource pour: ${track.title}`);
        log.trace('Track ID:', track.id);

        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            log.error('Audio dependencies not available, cannot create resource.');
            return null;
        }

        try {
            // Utiliser yt-dlp pour streamer directement
            log.debug('Utilisation de yt-dlp pour le streaming audio...');
            return await this.createResourceWithYtdlp(track.url, startSeconds);
        } catch (error) {
            log.error(`Erreur lors de la création de la ressource:`, error);
            return null;
        }
    }

    getDiscordOutputBitrateKbps(): number {
        return this.discordOpusBitrateKbps;
    }

    async getBestAudioBitrateKbps(url: string): Promise<number | null> {
        const dependenciesOk = await (this.dependenciesReady ?? this.checkDependencies());
        if (!dependenciesOk) {
            return null;
        }

        const includeCookies = this.hasCookieEnv();
        const primary = await this.fetchYtdlpInfo(url, includeCookies);
        if (primary.info) {
            return this.extractAudioBitrateKbps(primary.info);
        }

        if (includeCookies && this.isCookieCopyError(primary.ytdlpErrors)) {
            const fallback = await this.fetchYtdlpInfo(url, false);
            if (fallback.info) {
                return this.extractAudioBitrateKbps(fallback.info);
            }
        }

        return null;
    }

    /**
     * Crée une ressource audio en utilisant yt-dlp + FFmpeg
     */
    private async createResourceWithYtdlp(url: string, startSeconds: number = 0): Promise<AudioResource | null> {
        try {
            const includeCookies = this.hasCookieEnv();
            const primary = await this.createResourceWithYtdlpArgs(url, includeCookies, startSeconds);
            if (primary.resource) {
                return primary.resource;
            }

            if (includeCookies && this.isCookieCopyError(primary.ytdlpErrors)) {
                log.warn('yt-dlp cookies from browser failed, retrying without cookies');
                const fallback = await this.createResourceWithYtdlpArgs(url, false, startSeconds);
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
        url: string,
        includeCookies: boolean,
        startSeconds: number
    ): Promise<{ resource: AudioResource | null; ytdlpErrors: string }> {
        log.debug(`Creation du stream avec yt-dlp (${includeCookies ? 'cookies' : 'no-cookies'})...`);
        log.trace('URL:', url);

        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        // Arguments yt-dlp pour extraire l'audio et l'envoyer vers stdout
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
            '-f', 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
            '-o', '-', // Output vers stdout
            '--quiet',
            url,
        ];

        log.trace('yt-dlp args:', ytdlpArgs.join(' '));

        const ytdlp = spawn(this.ytdlpPath, ytdlpArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
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

        const resource = createAudioResource(stream, {
            inputType: StreamType.Raw, // PCM s16le
            inlineVolume: true,
        });

        if (resource.encoder && typeof resource.encoder.setBitrate === 'function') {
            resource.encoder.setBitrate(this.discordOpusBitrateKbps * 1000);
        }

        const readyState = await this.waitForStreamReady(ytdlp.stdout, ytdlp, ffmpeg, 5_000);
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

    private async fetchYtdlpInfo(
        url: string,
        includeCookies: boolean
    ): Promise<{ info: any | null; ytdlpErrors: string }> {
        const extraArgs = this.getYtdlpExtraArgs(includeCookies);
        const ytdlpArgs = [
            ...extraArgs,
            '--no-warnings',
            '--no-playlist',
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
            });

            ytdlp.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('error', (error) => {
                log.error('yt-dlp info error:', error);
                resolve({ info: null, ytdlpErrors: stderr });
            });

            ytdlp.on('close', (code) => {
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
    async preloadTracks(tracks: Track[]): Promise<void> {
        if (this.isPreloading) {
            log.trace('Pré-chargement déjà en cours, ignoré');
            return;
        }

        this.isPreloading = true;
        const toPreload = tracks.slice(0, config.audio.cacheAhead);
        log.debug(`Pré-vérification de ${toPreload.length} piste(s)...`);

        for (const track of toPreload) {
            if (this.cache.has(track.id)) {
                log.trace(`Déjà vérifié: ${track.title}`);
                continue;
            }

            try {
                log.trace(`Pré-vérification: ${track.title}`);

                // Avec yt-dlp, on met juste en cache l'ID pour savoir qu'on l'a vérifié
                this.cache.set(track.id, {
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

        this.isPreloading = false;
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

            for (const [trackId, entry] of this.cache.entries()) {
                if (now - entry.timestamp > maxAge) {
                    this.cache.delete(trackId);
                    cleaned++;
                }
            }

            if (cleaned > 0) {
                log.debug(`Nettoyage du cache: ${cleaned} entrée(s) supprimée(s)`);
            }
        }, 5 * 60 * 1000); // Vérifier toutes les 5 minutes
    }

    /**
     * Supprime une entrée du cache
     */
    clearFromCache(trackId: string): void {
        if (this.cache.delete(trackId)) {
            log.trace(`Supprimé du cache: ${trackId}`);
        }
    }

    /**
     * Vide tout le cache
     */
    clearCache(): void {
        const size = this.cache.size;
        this.cache.clear();
        log.info(`Cache vidé: ${size} entrée(s) supprimée(s)`);
    }

    /**
     * Obtient la taille du cache
     */
    getCacheSize(): number {
        return this.cache.size;
    }
}

export const audioWrapper = new AudioWrapper();



