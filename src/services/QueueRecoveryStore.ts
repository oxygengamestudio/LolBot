import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import type { GuildQueue, Track } from '../types/index.js';
import { writeJsonAtomic } from '../utils/atomicJson.js';
import { soundCloudService } from './SoundCloudService.js';

export const RECOVERY_TTL = 24 * 60 * 60 * 1000;
export interface QueueSnapshot {
    version: 1;
    guildId: string;
    textChannelId: string;
    voiceChannelId: string;
    updatedAt: number;
    tracks: Track[];
}

export function validateSnapshot(value: unknown, guildId: string): QueueSnapshot | null {
    const record = value as QueueSnapshot | null;
    if (!record || record.version !== 1 || record.guildId !== guildId ||
        !/^\d{17,20}$/.test(record.textChannelId) || !/^\d{17,20}$/.test(record.voiceChannelId) ||
        !Number.isFinite(record.updatedAt) || record.updatedAt > Date.now() + 60_000 ||
        Date.now() - record.updatedAt >= RECOVERY_TTL || !Array.isArray(record.tracks) ||
        !record.tracks.length || record.tracks.length > config.audio.maxQueueTracks + 1) return null;
    const tracks: Track[] = [];
    for (const track of record.tracks) {
        if (!track || typeof track.id !== 'string' ||
            typeof track.title !== 'string' || !Number.isFinite(track.duration) || track.duration < 0 ||
            typeof track.requestedBy !== 'string' || !/^\d{17,20}$/.test(track.requestedById)) return null;
        const provider = track.provider ?? 'youtube';
        let url: string;
        let thumbnail = '';
        let sourceId: string;
        if (provider === 'youtube' && /^[\w-]{11}$/.test(track.id)) {
            sourceId = track.id;
            url = `https://www.youtube.com/watch?v=${track.id}`;
            thumbnail = `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
        } else if (provider === 'soundcloud' && /^soundcloud:\d{1,30}$/.test(track.id)) {
            const canonical = track.canonicalUrl ?? track.url;
            if (typeof canonical !== 'string' || soundCloudService.classifyUrl(canonical) !== 'track') return null;
            sourceId = track.id.slice('soundcloud:'.length);
            url = 'https://soundcloud.com/' + new URL(canonical).pathname.split('/').filter(Boolean).join('/');
            if (typeof track.thumbnail === 'string' && /^https:\/\/i\d+\.sndcdn\.com\/[\w./%-]+$/.test(track.thumbnail)) thumbnail = track.thumbnail;
        } else return null;
        // Persist canonical public catalogue locations, never temporary stream URLs or tokens.
        tracks.push({ id: track.id, title: track.title.slice(0, 256), duration: track.duration,
            url, canonicalUrl: url, sourceId, provider, thumbnail,
            requestedBy: track.requestedBy.slice(0, 100), requestedById: track.requestedById,
            channelTitle: typeof track.channelTitle === 'string' ? track.channelTitle.slice(0, 100) : '',
            sourceType: 'url' });
    }
    return { version: 1, guildId, textChannelId: record.textChannelId,
        voiceChannelId: record.voiceChannelId, updatedAt: record.updatedAt, tracks };
}

export function snapshotQueue(queue: GuildQueue): QueueSnapshot | null {
    return validateSnapshot({ version: 1, guildId: queue.guildId, textChannelId: queue.textChannel.id,
        voiceChannelId: queue.voiceChannel.id, updatedAt: Date.now(),
        tracks: [...(queue.currentTrack ? [queue.currentTrack] : []), ...queue.tracks] }, queue.guildId);
}

export class QueueRecoveryStore {
    constructor(private readonly directory = config.paths.guilds) {}

    private path(guildId: string): string {
        if (!/^\d{17,20}$/.test(guildId)) throw new Error('Invalid guild ID');
        return join(this.directory, guildId, 'queue-recovery.json');
    }

    async load(guildId: string): Promise<QueueSnapshot | null> {
        const path = this.path(guildId);
        try {
            if ((await stat(path)).size > 2 * 1024 * 1024) return null;
            return validateSnapshot(JSON.parse(await readFile(path, 'utf8')), guildId);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async save(guildId: string, snapshot: QueueSnapshot | null): Promise<void> {
        const path = this.path(guildId);
        if (!snapshot) {
            await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
            return;
        }
        const validated = validateSnapshot(snapshot, guildId);
        if (!validated) throw new Error('Invalid queue snapshot');
        await writeJsonAtomic(path, validated);
    }
}
