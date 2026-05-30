import type {
    ButtonInteraction,
    ChatInputCommandInteraction,
    ModalSubmitInteraction,
    Message,
    TextBasedChannel,
} from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { geniusService } from '../services/GeniusService.js';
import { queueManager } from '../services/QueueManager.js';
import { nowPlayingManager } from '../services/NowPlayingManager.js';
import type { GuildQueue } from '../types/index.js';
import { config } from '../config.js';
import { resolveLocale, t } from './i18n.js';
import { logger } from './Logger.js';
import { safeContent } from './text.js';
import type { Track } from '../types/index.js';

const log = logger.createModuleLogger('Lyrics');

type LyricsInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;

export function buildTrackLyricsQuery(track: Track): string {
    const cleanedTitle = cleanLyricsQueryText(track.title);
    const cleanedChannel = cleanLyricsQueryText(track.channelTitle ?? '');
    const query = dedupeLyricsQueryWords([cleanedTitle, cleanedChannel].filter(Boolean).join(' '));

    return query || track.title;
}

function cleanLyricsQueryText(text: string): string {
    return text
        .replace(/\b(official|officiel|officielle|lyrics?|lyric|audio|video|clip|mv|m\/v|visualizer|hd|hq|4k|8k)\b/gi, ' ')
        .replace(/\b(remastered|remaster|version|edit|prod|produced|karaoke|instrumental)\b/gi, ' ')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/[|•]/g, ' ')
        .replace(/[^\p{L}\p{N}&' -]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function dedupeLyricsQueryWords(text: string): string {
    const seen = new Set<string>();
    const words: string[] = [];

    for (const word of text.split(/\s+/).filter(Boolean)) {
        const key = word
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/[^a-z0-9]/g, '');
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        words.push(word);
    }

    return words.join(' ').slice(0, 180).trim();
}

export async function sendLyrics(
    interaction: LyricsInteraction,
    query: string,
    queue?: GuildQueue
): Promise<void> {
    const locale = await resolveLocale(interaction.guildId, interaction.locale);
    const guildId = interaction.guildId;
    const targetQueue = queue ?? (guildId ? queueManager.getQueue(guildId) : undefined);
    const trackId = targetQueue?.currentTrack?.id ?? null;

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ content: t(locale, 'lyrics.loading') });

        const result = await geniusService.getLyrics(query);
        if (!result) {
            await interaction.editReply({ content: t(locale, 'lyrics.notFound') });
            scheduleDelete(interaction);
            return;
        }

        const channel = targetQueue?.textChannel ?? interaction.channel;
        if (!channel || !isSendable(channel)) {
            await interaction.editReply({ content: t(locale, 'error.generic') });
            scheduleDelete(interaction);
            return;
        }

        if (targetQueue) {
            queueManager.clearLyrics(targetQueue);
        }

        const messages = await sendLyricsMessages(channel, result);
        if (targetQueue) {
            targetQueue.lyricsMessages = messages;
            targetQueue.lyricsTrackId = trackId;

            // Regenerate now playing so it stays as the last message
            if (targetQueue.currentTrack) {
                await nowPlayingManager.deleteNowPlaying(targetQueue);
                await nowPlayingManager.createOrUpdateNowPlaying(targetQueue);
            }
        }

        await interaction.editReply({ content: `✅ ${t(locale, 'lyrics.sent')}`.trim() });
        scheduleDelete(interaction);
    } catch (error) {
        log.error('Lyrics error:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: t(locale, 'error.generic') });
        } else {
            await interaction.reply({ content: t(locale, 'error.generic'), flags: MessageFlags.Ephemeral });
        }
        scheduleDelete(interaction);
    }
}

function isSendable(channel: TextBasedChannel): channel is TextBasedChannel & { send: (...args: any[]) => Promise<Message> } {
    return typeof (channel as any).send === 'function';
}

async function sendLyricsMessages(
    channel: TextBasedChannel & { send: (...args: any[]) => Promise<Message> },
    result: { title: string; fullTitle: string; artist: string; url: string; lyrics: string }
): Promise<Message[]> {
    const headerTitle = result.title && result.artist
        ? `${safeContent(result.title)} - ${safeContent(result.artist)}`
        : safeContent(result.fullTitle || result.title);
    const header = `## 🎤 ${headerTitle}`.trim();
    const source = result.url ? `Source: ${result.url}` : '';
    const formattedLyrics = formatLyricsForDiscord(result.lyrics);
    const chunks = splitLyrics(formattedLyrics, 1800);
    if (chunks.length === 0) {
        return [];
    }

    chunks[0] = [header, source, chunks[0]].filter(Boolean).join('\n\n');

    const messages: Message[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const message = await channel.send({
            content: chunks[i],
            allowedMentions: { parse: [] },
            ...(isLast ? { components: [createDeleteButton()] } : {}),
        });
        messages.push(message);
    }

    return messages;
}

function formatLyricsForDiscord(text: string): string {
    const lines = text
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n');

    return lines
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return '';
            }

            if (/^\[[^\]]{1,80}\]$/.test(trimmed)) {
                return `**${safeContent(trimmed)}**`;
            }

            return `> ${safeContent(trimmed)}`;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function splitLyrics(text: string, maxLength: number): string[] {
    const lines = text.split(/\r?\n/);
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
        const safeLine = line.trimEnd();
        const candidate = current ? `${current}\n${safeLine}` : safeLine;
        if (candidate.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            if (safeLine.length > maxLength) {
                const parts = safeLine.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
                for (const part of parts) {
                    chunks.push(part);
                }
            } else {
                current = safeLine;
            }
        } else {
            current = candidate;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks.filter(chunk => chunk.trim().length > 0);
}

function createDeleteButton(): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setCustomId('lyrics_delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

export async function handleLyricsDelete(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId;
    const queue = guildId ? queueManager.getQueue(guildId) : undefined;

    if (queue) {
        queueManager.clearLyrics(queue);
    }

    try {
        await interaction.reply({
            content: '🗑️',
            flags: MessageFlags.Ephemeral,
        });
        const delayMs = Math.max(1, config.audio.ephemeralInfoDeleteDelay);
        setTimeout(async () => {
            try { await interaction.deleteReply(); } catch { /* ignore */ }
        }, delayMs);
    } catch {
        // ignore
    }
}

function scheduleDelete(interaction: LyricsInteraction): void {
    const delayMs = Math.max(1, config.audio.ephemeralInfoDeleteDelay);
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignore
        }
    }, delayMs);
}
