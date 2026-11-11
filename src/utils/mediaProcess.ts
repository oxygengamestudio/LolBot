import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { logger } from './Logger.js';

/**
 * Source unique pour tout ce qui lance yt-dlp ou FFmpeg : chemin des binaires,
 * arguments d'exécution (cookies, arguments libres), environnement transmis aux
 * processus enfants et arrêt borné. AudioWrapper, MediaCacheManager et
 * YtdlpRunner passent tous par ici.
 */

const log = logger.createModuleLogger('MediaProcess');

export const PROCESS_KILL_GRACE_MS = 2_000;

/** Seules ces variables atteignent un processus enfant : jamais le token Discord ni les clés d'API. */
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

export function getSafeChildEnv(tempDir: string = config.paths.cache): NodeJS.ProcessEnv {
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

export function resolveYtdlpPath(): string {
    if (process.env.YTDLP_PATH) {
        return process.env.YTDLP_PATH;
    }
    const fileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const localPath = join(config.paths.data, 'bin', fileName);
    return existsSync(localPath) ? localPath : 'yt-dlp';
}

export function resolveFfmpegPath(): string {
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Découpe une ligne d'arguments en respectant les guillemets simples et doubles. */
export function parseCommandLineArgs(rawArgs: string | undefined): string[] {
    const matches = rawArgs?.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
    if (!matches) return [];
    return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ''));
}

let warnedUnsafeExtraArgsIgnored = false;

/** `YTDLP_EXTRA_ARGS`, uniquement si `YTDLP_ALLOW_UNSAFE_EXTRA_ARGS` l'autorise. */
function getUnsafeYtdlpExtraArgs(): string[] {
    const extraArgs = parseCommandLineArgs(process.env.YTDLP_EXTRA_ARGS);
    if (extraArgs.length === 0) {
        return [];
    }
    if (config.audio.allowUnsafeYtdlpExtraArgs) {
        return extraArgs;
    }
    if (!warnedUnsafeExtraArgsIgnored) {
        warnedUnsafeExtraArgsIgnored = true;
        log.warn('YTDLP_EXTRA_ARGS ignored. Set YTDLP_ALLOW_UNSAFE_EXTRA_ARGS=true only in a trusted environment.');
    }
    return [];
}

/** Arguments ajoutés à chaque appel yt-dlp : cookies configurés puis arguments libres autorisés. */
export function getYtdlpRuntimeArgs(includeCookies = true): string[] {
    const args: string[] = [];
    const cookiesFromBrowser = includeCookies ? process.env.YTDLP_COOKIES_FROM_BROWSER : undefined;
    const cookies = includeCookies ? process.env.YTDLP_COOKIES : undefined;

    if (cookiesFromBrowser) {
        args.push('--cookies-from-browser', cookiesFromBrowser);
    } else if (cookies) {
        args.push('--cookies', cookies);
    }

    args.push(...getUnsafeYtdlpExtraArgs());
    return args;
}

export function hasYtdlpCookieConfig(): boolean {
    if (process.env.YTDLP_COOKIES_FROM_BROWSER || process.env.YTDLP_COOKIES) {
        return true;
    }
    return getUnsafeYtdlpExtraArgs().some((arg) =>
        arg === '--cookies' ||
        arg === '--cookies-from-browser' ||
        arg.startsWith('--cookies=') ||
        arg.startsWith('--cookies-from-browser=')
    );
}

/** SIGTERM, puis SIGKILL si le processus n'a pas quitté après le délai de grâce. */
export function terminateChildProcess(child: ChildProcess, graceMs: number = PROCESS_KILL_GRACE_MS): void {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    try {
        child.kill('SIGTERM');
    } catch {
        return;
    }
    const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                child.kill('SIGKILL');
            } catch {
                // Le processus est déjà fermé.
            }
        }
    }, graceMs);
    forceKill.unref?.();
    child.once('close', () => clearTimeout(forceKill));
}
