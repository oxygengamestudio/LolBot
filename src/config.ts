import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
    nodeEnv: NodeEnv;
    discord: {
        token: string;
        clientId: string;
        guildId?: string;
    };
    youtube: {
        apiKey: string;
    };
    riot: {
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
        ownerId: string;
    };
    audio: {
        bufferSize: number;
        cacheAhead: number;
        updateInterval: number;
        ephemeralInfoDeleteDelay: number;
        ephemeralInteractiveDeleteDelay: number;
        maxQueueTracks: number;
        maxPlaylistTracks: number;
        searchResults: number;
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

const discordToken = getRequiredEnv('DISCORD_TOKEN');
const discordClientId = getRequiredEnv('DISCORD_CLIENT_ID', ['CLIENT_ID']);
const discordGuildId = getOptionalEnv('DISCORD_GUILD_ID', ['GUILD_ID']);
const googleApiKey = getRequiredEnv('GOOGLE_API_KEY', ['YOUTUBE_API_KEY']);

export const config: AppConfig = {
    nodeEnv: normalizeNodeEnv(),
    discord: {
        token: discordToken,
        clientId: discordClientId,
        guildId: discordGuildId,
    },
    youtube: {
        apiKey: googleApiKey,
    },
    riot: {
        apiKey: getOptionalEnv('RIOT_API_KEY'),
    },
    genius: {
        accessToken: getOptionalEnv('GENIUS_ACCESS_TOKEN'),
        clientId: getOptionalEnv('GENIUS_CLIENT_ID'),
        clientSecret: getOptionalEnv('GENIUS_CLIENT_SECRET'),
    },
    paths: {
        root: join(__dirname, '..'),
        data: join(__dirname, '..', 'data'),
        cache: join(__dirname, '..', 'data', 'cache'),
        guilds: join(__dirname, '..', 'data', 'guild'),
    },
    bot: {
        ownerId: '189457295279783936',
    },
    audio: {
        bufferSize: 5,
        cacheAhead: 3,
        updateInterval: 5000,
        ephemeralInfoDeleteDelay: 5000,
        ephemeralInteractiveDeleteDelay: 30000,
        maxQueueTracks: 100,
        maxPlaylistTracks: 50,
        searchResults: 10,
    },
};
