import type { VoiceConnection, AudioPlayer } from '@discordjs/voice';
import type {
    TextChannel,
    Message,
    VoiceChannel,
    StageChannel,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
} from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';

export interface Track {
    id: string;
    /** Fournisseur du catalogue. Les anciennes pistes sans valeur restent YouTube. */
    provider?: 'youtube' | 'soundcloud' | (string & {});
    /** Identifiant de la piste chez le fournisseur. Utilise `id` par défaut. */
    sourceId?: string;
    /** URL canonique stable. Utilise `url` par défaut. */
    canonicalUrl?: string;
    /** Métadonnées techniques optionnelles utilisées pour éviter un transcodage inutile. */
    codec?: string;
    container?: string;
    isLive?: boolean;
    title: string;
    url: string;
    duration: number; // en secondes
    originalDuration?: number;
    thumbnail: string;
    channelTitle?: string;
    channelId?: string;
    sourceType?: 'url' | 'search' | 'playlist';
    requestedBy: string;
    requestedById: string;
}

export interface SearchResult {
    id: string;
    title: string;
    duration: string;
    thumbnail: string;
    channelTitle: string;
    channelId?: string;
    durationSeconds?: number;
    viewCount?: number;
    sourceRank?: number;
    isOfficial?: boolean;
}

export interface PlaylistInfo {
    id: string;
    title: string;
    itemCount: number;
    tracks: Track[];
}

export type PlaybackStatus = 'idle' | 'starting' | 'playing' | 'paused' | 'stopping';
export type PauseReason = 'user' | 'empty_channel';

export interface GuildQueue {
    guildId: string;
    textChannel: TextChannel;
    voiceChannel: VoiceChannel | StageChannel;
    connection: VoiceConnection | null;
    player: AudioPlayer | null;
    tracks: Track[];
    currentTrack: Track | null;
    /** État de lecture unique ; ne se modifie que via QueueManager (voir GuildPlayback.ts). */
    playback: PlaybackStatus;
    /** Renseigné uniquement quand `playback === 'paused'`. */
    pauseReason: PauseReason | null;
    volume: number;
    nowPlayingMessage: Message | null;
    lyricsMessages: Message[];
    lyricsTrackId: string | null;
    startedAt: number | null;
    pausedAt: number | null;
    totalPausedTime: number;
    isReconnecting: boolean;
    reconnectAttempts: number;
    shouldKeepConnection: boolean;
    isManualDisconnect: boolean;
    lastStartMetrics: {
        joinMs: number | null;
        warmupMs: number | null;
        resourceMs: number | null;
        warmHit: boolean;
        sourceMode: 'direct' | 'ytdlp' | 'unknown';
    } | null;
}

export interface CachedAudio {
    trackId: string;
    buffer: Buffer;
    timestamp: number;
}

export interface AudioStreamInfo {
    url: string;
    format: string;
    bitrate: number;
    contentLength: number;
}

export interface YouTubeVideoInfo {
    id: string;
    title: string;
    duration: number;
    thumbnail: string;
    channelTitle?: string;
    channelId?: string;
}

export interface CommandDefinition {
    data: {
        name: string;
        description: string;
        toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody;
    };
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export type VoiceChannelMode = 'allow_all' | 'whitelist' | 'blacklist';
export type RolePermissionMode = 'allow_all' | 'whitelist' | 'blacklist';

export interface GuildSettings {
    guildId: string;
    locale: 'en' | 'fr';
    volume: number;
    stayConnected: boolean;
    stayConnectedAlways: boolean;
    pauseOnEmptyChannelWhenAlwaysConnected: boolean;
    /** Durée du fondu enchaîné en secondes ; 0 = désactivé (transition gapless). */
    crossfadeSeconds: number;
    /** Dérivé de `crossfadeSeconds`. Conservé pour les réglages déjà enregistrés. */
    crossfadeEnabled: boolean;
    sponsorBlockEnabled: boolean;
    queueRecoveryEnabled: boolean;
    preferredVoiceChannel: string | null;
    voiceChannelMode: VoiceChannelMode;
    allowedVoiceChannels: string[];
    blockedVoiceChannels: string[];
    rolePermissionMode: RolePermissionMode;
    allowedRoles: string[];
    blockedRoles: string[];
}
