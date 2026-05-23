import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join } from 'path';

if (process.env.BOT_ENV_FILE) {
    dotenvConfig({ path: process.env.BOT_ENV_FILE, override: false });
}

dotenvConfig({ override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootPath = join(__dirname, '..');

type NodeEnv = 'development' | 'test' | 'production';
type CommandScope = 'auto' | 'guild' | 'global';

export interface AppConfig {
    nodeEnv: NodeEnv;
    discord: {
        token: string;
        clientId: string;
        guildId?: string;
        commandScope: CommandScope;
    };
    youtube: {
        apiKey?: string;
    };
    genius: {
        accessToken?: string;
        clientId?: string;
        clientSecret?: string;
    };
    paths: {
        root: string;
        data: string;
        cache: string;
        guilds: string;
    };
    bot: {
        ownerId?: string;
    };
    audio: {
        bufferSize: number;
        cacheAhead: number;
        cacheMaxMb: number;
        cacheMaxAgeHours: number;
        ytDlpTimeoutMs: number;
        ffmpegTimeoutMs: number;
        voiceReconnectMaxAttempts: number;
        voiceReconnectBaseDelayMs: number;
        voiceReconnectMaxDelayMs: number;
        updateInterval: number;
        ephemeralInfoDeleteDelay: number;
        ephemeralInteractiveDeleteDelay: number;
        maxQueueTracks: number;
        maxPlaylistTracks: number;
        searchResults: number;
        ytdlpAutoDownload: boolean;
        allowUnsafeYtdlpExtraArgs: boolean;
    };
}

const warnedFallbacks = new Set<string>();

function getTrimmedEnv(name: string): string | undefined {
    const value = process.env[name];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function warnLegacyEnv(fallbackName: string, primaryName: string): void {
    const key = `${fallbackName}->${primaryName}`;
    if (warnedFallbacks.has(key)) {
        return;
    }

    warnedFallbacks.add(key);
    console.warn(`[config] Environment variable "${fallbackName}" is deprecated. Use "${primaryName}" instead.`);
}

function getOptionalEnv(primaryName: string, fallbackNames: string[] = []): string | undefined {
    const primaryValue = getTrimmedEnv(primaryName);
    if (primaryValue) {
        return primaryValue;
    }

    for (const fallbackName of fallbackNames) {
        const fallbackValue = getTrimmedEnv(fallbackName);
        if (fallbackValue) {
            warnLegacyEnv(fallbackName, primaryName);
            return fallbackValue;
        }
    }

    return undefined;
}

function getRequiredEnv(primaryName: string, fallbackNames: string[] = []): string {
    const value = getOptionalEnv(primaryName, fallbackNames);
    if (value) {
        return value;
    }

    const fallbackHint = fallbackNames.length > 0
        ? ` (legacy fallback: ${fallbackNames.join(', ')})`
        : '';

    throw new Error(
        `[config] Missing required environment variable "${primaryName}"${fallbackHint}. ` +
            'Set it in your environment or in a local .env file before starting the bot.'
    );
}

function normalizeNodeEnv(): NodeEnv {
    const rawNodeEnv = getTrimmedEnv('NODE_ENV');
    if (!rawNodeEnv) {
        return 'development';
    }

    const normalized = rawNodeEnv.toLowerCase();
    if (normalized === 'production' || normalized === 'development' || normalized === 'test') {
        return normalized;
    }

    console.warn(`[config] Unsupported NODE_ENV value "${rawNodeEnv}". Falling back to "development".`);
    return 'development';
}

function normalizeCommandScope(): CommandScope {
    const rawScope = getOptionalEnv('DISCORD_COMMAND_SCOPE');
    if (!rawScope) {
        return 'auto';
    }

    const normalized = rawScope.toLowerCase();
    if (normalized === 'auto' || normalized === 'guild' || normalized === 'global') {
        return normalized;
    }

    throw new Error(
        `[config] Invalid DISCORD_COMMAND_SCOPE "${rawScope}". Allowed values: auto, guild, global.`
    );
}

function normalizeBooleanEnv(name: string, defaultValue: boolean): boolean {
    const rawValue = getTrimmedEnv(name);
    if (!rawValue) {
        return defaultValue;
    }

    const normalized = rawValue.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    console.warn(`[config] Unsupported boolean value "${rawValue}" for ${name}. Falling back to ${defaultValue}.`);
    return defaultValue;
}

function resolvePathEnv(name: string, defaultPath: string): string {
    const rawValue = getOptionalEnv(name);
    if (!rawValue) {
        return defaultPath;
    }

    return isAbsolute(rawValue) ? rawValue : join(rootPath, rawValue);
}

const discordToken = getRequiredEnv('DISCORD_TOKEN');
const discordClientId = getRequiredEnv('DISCORD_CLIENT_ID', ['CLIENT_ID']);
const discordGuildId = getOptionalEnv('DISCORD_GUILD_ID', ['GUILD_ID']);
const discordCommandScope = normalizeCommandScope();
const googleApiKey = getOptionalEnv('GOOGLE_API_KEY', ['YOUTUBE_API_KEY']);
const dataPath = resolvePathEnv('DATA_DIR', join(rootPath, 'data'));
const cachePath = resolvePathEnv('CACHE_DIR', join(dataPath, 'cache'));
const guildsPath = resolvePathEnv('GUILDS_DIR', join(dataPath, 'guild'));

export const config: AppConfig = {
    nodeEnv: normalizeNodeEnv(),
    discord: {
        token: discordToken,
        clientId: discordClientId,
        guildId: discordGuildId,
        commandScope: discordCommandScope,
    },
    youtube: {
        apiKey: googleApiKey,
    },
    genius: {
        accessToken: getOptionalEnv('GENIUS_ACCESS_TOKEN'),
        clientId: getOptionalEnv('GENIUS_CLIENT_ID'),
        clientSecret: getOptionalEnv('GENIUS_CLIENT_SECRET'),
    },
    paths: {
        root: rootPath,
        data: dataPath,
        cache: cachePath,
        guilds: guildsPath,
    },
    bot: {
        ownerId: getOptionalEnv('BOT_OWNER_ID'),
    },
    audio: {
        bufferSize: 5,
        cacheAhead: 5,
        cacheMaxMb: 1536,
        cacheMaxAgeHours: 24,
        ytDlpTimeoutMs: 20_000,
        ffmpegTimeoutMs: 12_000,
        voiceReconnectMaxAttempts: 4,
        voiceReconnectBaseDelayMs: 1_000,
        voiceReconnectMaxDelayMs: 8_000,
        updateInterval: 5000,
        ephemeralInfoDeleteDelay: 5000,
        ephemeralInteractiveDeleteDelay: 30000,
        maxQueueTracks: 100,
        maxPlaylistTracks: 50,
        searchResults: 10,
        ytdlpAutoDownload: normalizeBooleanEnv('YTDLP_AUTO_DOWNLOAD', false),
        allowUnsafeYtdlpExtraArgs: normalizeBooleanEnv('YTDLP_ALLOW_UNSAFE_EXTRA_ARGS', false),
    },
};
