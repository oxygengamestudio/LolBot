import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
    discord: {
        token: process.env.DISCORD_TOKEN!,
        clientId: process.env.CLIENT_ID!,
        guildId: process.env.GUILD_ID!,
    },
    youtube: {
        apiKey: process.env.YOUTUBE_API_KEY!,
    },
    riot: {
        apiKey: process.env.RIOT_API_KEY!,
    },
    genius: {
        accessToken: process.env.GENIUS_ACCESS_TOKEN,
        clientId: process.env.GENIUS_CLIENT_ID,
        clientSecret: process.env.GENIUS_CLIENT_SECRET,
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

const requiredEnvVars = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'YOUTUBE_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Variable d'environnement manquante: ${envVar}`);
    }
}
