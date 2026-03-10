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
    title: string;
    url: string;
    duration: number; // en secondes
    thumbnail: string;
    requestedBy: string;
    requestedById: string;
}

export interface SearchResult {
    id: string;
    title: string;
    duration: string;
    thumbnail: string;
    channelTitle: string;
}

export interface PlaylistInfo {
    id: string;
    title: string;
    itemCount: number;
    tracks: Track[];
}

export interface GuildQueue {
    guildId: string;
    textChannel: TextChannel;
    voiceChannel: VoiceChannel | StageChannel;
    connection: VoiceConnection | null;
    player: AudioPlayer | null;
    tracks: Track[];
    currentTrack: Track | null;
    isPlaying: boolean;
    isPaused: boolean;
    isStopping: boolean;
    volume: number;
    nowPlayingMessage: Message | null;
    lyricsMessages: Message[];
    lyricsTrackId: string | null;
    startedAt: number | null;
    pausedAt: number | null;
    totalPausedTime: number;
    autoPausedByEmptyChannel: boolean;
    crossfadeInProgress: boolean;
    crossfadeTargetTrackId: string | null;
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
    crossfadeEnabled: boolean;
    preferredVoiceChannel: string | null;
    voiceChannelMode: VoiceChannelMode;
    allowedVoiceChannels: string[];
    blockedVoiceChannels: string[];
    rolePermissionMode: RolePermissionMode;
    allowedRoles: string[];
    blockedRoles: string[];
}
