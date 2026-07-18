import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ComponentType,
    GuildMember,
    MessageFlags,
} from 'discord.js';
import { queueManager } from './QueueManager.js';
import { queueViewManager } from './QueueViewManager.js';
import { buildTrackLyricsQuery, sendLyrics } from '../utils/lyrics.js';
import { config } from '../config.js';
import { resolveLocale, t } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { guildSettingsManager } from './GuildSettingsManager.js';
import type { GuildQueue } from '../types/index.js';
import { safeContent } from '../utils/text.js';
import { ensureCanUseBot, ensureSameVoiceChannel } from '../utils/commandHelpers.js';

const log = logger.createModuleLogger('NowPlaying');

class NowPlayingManager {
    private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
    private pendingUpdates: Map<string, GuildQueue> = new Map();
    private retryTimers: Map<string, NodeJS.Timeout> = new Map();
    private retryAttempts: Map<string, number> = new Map();
    private updatesInFlight = 0;
    private readonly maxConcurrentUpdates = 2;
    private readonly maxRetryAttempts = 5;
    private readonly retryBaseDelayMs = 1_000;
    private readonly retryMaxDelayMs = 30_000;
    private readonly retryJitterMs = 250;
    private readonly COLORS = {
        playing: 0x1DB954,
        paused: 0xFFA500,
        idle: 0x808080,
    };

    constructor() {
        log.info('NowPlayingManager initialise');

        queueManager.on('trackStart', (queue: GuildQueue) => this.onTrackStart(queue));
        queueManager.on('trackEnd', (queue: GuildQueue) => this.onTrackEnd(queue));
        queueManager.on('trackPaused', (queue: GuildQueue) => this.scheduleUpdate(queue));
        queueManager.on('queueStopped', (queue: GuildQueue) => this.deleteNowPlaying(queue));
        queueManager.on('queueEmpty', (queue: GuildQueue) => this.deleteNowPlaying(queue));
        queueManager.on('queueDeleted', (guildId: string) => this.stopUpdateInterval(guildId));
    }

    private async onTrackStart(queue: GuildQueue): Promise<void> {
        log.debug(`Track start: ${queue.currentTrack?.title}`);
        await this.createOrUpdateNowPlaying(queue);
        this.startUpdateInterval(queue);
    }

    private async onTrackEnd(_queue: GuildQueue): Promise<void> {
        log.debug('Track end');
    }

    async createOrUpdateNowPlaying(queue: GuildQueue): Promise<void> {
        if (!queue.currentTrack) {
            log.trace('Pas de track actuel, skip');
            return;
        }

        const locale = await resolveLocale(queue.guildId);
        const components = this.createNowPlayingComponents(queue, locale);

        try {
            if (queue.nowPlayingMessage) {
                log.trace('Mise a jour du message Now Playing existant');
                await queue.nowPlayingMessage.edit({
                    embeds: [],
                    components,
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: { parse: [] },
                });
            } else {
                log.debug('Creation d\'un nouveau message Now Playing');
                const message = await queue.textChannel.send({
                    components,
                    flags: MessageFlags.IsComponentsV2,
                    allowedMentions: { parse: [] },
                });
                queue.nowPlayingMessage = message;
                log.info('Message Now Playing cree');
            }
        } catch (error) {
            log.error('Erreur lors de la mise a jour:', error);
            if (this.getDiscordErrorCode(error) === '10008' && queue.nowPlayingMessage) {
                await queue.nowPlayingMessage.delete().catch(() => undefined);
                queue.nowPlayingMessage = null;
                await this.createOrUpdateNowPlaying(queue);
                return;
            }
            if (this.isPermanentDiscordError(error)) {
                this.abandonNowPlayingUpdates(queue, error);
                return;
            }
            if (queue.nowPlayingMessage) {
                this.scheduleRetry(queue, error);
            }
        }
    }

    async updateNowPlaying(queue: GuildQueue): Promise<void> {
        if (!queue.nowPlayingMessage || !queue.currentTrack) return;

        const locale = await resolveLocale(queue.guildId);
        const components = this.createNowPlayingComponents(queue, locale);

        try {
            await queue.nowPlayingMessage.edit({
                embeds: [],
                components,
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            });
            this.clearRetryState(queue.guildId);
        } catch (error) {
            if (this.isPermanentDiscordError(error)) {
                this.abandonNowPlayingUpdates(queue, error);
                return;
            }
            this.scheduleRetry(queue, error);
        }
    }

    async deleteNowPlaying(queue: GuildQueue): Promise<void> {
        log.debug('Suppression du message Now Playing');
        this.stopUpdateInterval(queue.guildId);

        if (queue.nowPlayingMessage) {
            try {
                await queue.nowPlayingMessage.delete();
                log.info('Message Now Playing supprime');
            } catch {
                log.trace('Message deja supprime');
            }
            queue.nowPlayingMessage = null;
        }
    }

    private createNowPlayingComponents(queue: GuildQueue, locale: 'en' | 'fr'): any[] {
        const track = queue.currentTrack!;
        const currentTime = queueManager.getCurrentTime(queue.guildId);
        const progress = this.createProgressBar(currentTime, track.duration);
        const currentTimeString = this.formatTime(currentTime);
        const totalTimeString = this.formatTime(track.duration);
        const progressLine = `\`${currentTimeString}\` ${progress} \`${totalTimeString}\``;
        const color = queue.isPaused ? this.COLORS.paused : this.COLORS.playing;
        const statusLabel = queue.isPaused
            ? `⏸️ ${t(locale, 'nowPlaying.status.paused')}`
            : `▶️ ${t(locale, 'nowPlaying.status.playing')}`;
        const squareCover = this.getSquareThumbnail(track.thumbnail);
        const info = [
            `**${statusLabel}**`,
            `### [${safeContent(track.title)}](${track.url})`,
            progressLine,
            '',
            `**${t(locale, 'nowPlaying.field.info')}**`,
            `👤 <@${track.requestedById}>`,
            `📋 ${t(locale, 'nowPlaying.queueCount', { count: queue.tracks.length })}`,
            `🔊 ${queue.volume}%`,
            '',
            queue.isPaused
                ? t(locale, 'nowPlaying.footer.paused')
                : t(locale, 'nowPlaying.footer.playing'),
        ].join('\n');

        const displayComponents: any[] = [
            {
                type: ComponentType.TextDisplay,
                content: info,
            },
        ];

        if (squareCover) {
            displayComponents.push({
                type: ComponentType.MediaGallery,
                items: [
                    {
                        media: { url: squareCover },
                        description: safeContent(track.title).slice(0, 100),
                    },
                ],
            });
        }

        return [
            {
                type: ComponentType.Container,
                accent_color: color,
                components: [
                    ...displayComponents,
                    {
                        type: ComponentType.Separator,
                        divider: true,
                        spacing: 1,
                    },
                    this.createButtons(queue, locale).toJSON(),
                ],
            },
        ];
    }

    private createButtons(queue: GuildQueue, locale: 'en' | 'fr'): ActionRowBuilder<ButtonBuilder> {
        const playPauseButton = new ButtonBuilder()
            .setCustomId(queue.isPaused ? 'np_resume' : 'np_pause')
            .setEmoji(queue.isPaused ? '▶️' : '⏸️')
            .setLabel(queue.isPaused ? t(locale, 'nowPlaying.button.resume') : t(locale, 'nowPlaying.button.pause'))
            .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);

        const skipButton = new ButtonBuilder()
            .setCustomId('np_skip')
            .setEmoji('⏭️')
            .setLabel(t(locale, 'nowPlaying.button.skip'))
            .setStyle(ButtonStyle.Primary);

        const queueButton = new ButtonBuilder()
            .setCustomId('np_queue')
            .setEmoji('📋')
            .setLabel(t(locale, 'nowPlaying.button.queue'))
            .setStyle(ButtonStyle.Secondary);

        const lyricsButton = new ButtonBuilder()
            .setCustomId('np_lyrics')
            .setEmoji('🎤')
            .setLabel(t(locale, 'nowPlaying.button.lyrics'))
            .setStyle(ButtonStyle.Secondary);

        const stopButton = new ButtonBuilder()
            .setCustomId('np_stop')
            .setEmoji('⏹️')
            .setLabel(t(locale, 'nowPlaying.button.stop'))
            .setStyle(ButtonStyle.Danger);

        return new ActionRowBuilder<ButtonBuilder>()
            .addComponents(playPauseButton, skipButton, queueButton, lyricsButton, stopButton);
    }

    private createProgressBar(current: number, total: number): string {
        const barLength = 18;
        const safeTotal = Math.max(total, 1);
        const progress = Math.min(current / safeTotal, 1);
        const filled = Math.round(progress * barLength);
        let bar = '';
        for (let i = 0; i < barLength; i += 1) {
            bar += i < filled ? '▰' : '▱';
        }
        return `\`${bar}\``;
    }

    private formatTime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    private getSquareThumbnail(url: string): string {
        if (!url) {
            return url;
        }

        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:') {
                return '';
            }
            const host = parsed.hostname.toLowerCase();

            if (host.endsWith('ytimg.com') || host.endsWith('youtube.com') || host.endsWith('youtu.be')) {
                const source = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
                const params = new URLSearchParams({
                    url: source,
                    w: '768',
                    h: '768',
                    fit: 'cover',
                    a: 'center',
                    output: 'jpg',
                });
                return `https://wsrv.nl/?${params.toString()}`;
            }
        } catch {
            return url;
        }

        return url;
    }

    private startUpdateInterval(queue: GuildQueue): void {
        this.stopUpdateInterval(queue.guildId);

        log.debug('Demarrage de l\'intervalle de mise a jour');
        const interval = setInterval(() => {
            const currentQueue = queueManager.getQueue(queue.guildId);
            if (currentQueue && currentQueue.isPlaying && !currentQueue.isPaused) {
                this.scheduleUpdate(currentQueue);
            }
        }, config.audio.updateInterval);

        this.updateIntervals.set(queue.guildId, interval);
    }

    private stopUpdateInterval(guildId: string): void {
        const interval = this.updateIntervals.get(guildId);
        if (interval) {
            log.debug('Arret de l\'intervalle de mise a jour');
            clearInterval(interval);
            this.updateIntervals.delete(guildId);
        }
        this.pendingUpdates.delete(guildId);
        this.clearRetryState(guildId);
    }

    private scheduleUpdate(queue: GuildQueue, allowRetryDispatch = false): void {
        if (queueManager.getQueue(queue.guildId) !== queue) {
            return;
        }
        if (this.retryTimers.has(queue.guildId) && !allowRetryDispatch) {
            log.trace(`Mise à jour périodique ignorée pendant le backoff: ${queue.guildId}`);
            return;
        }
        this.pendingUpdates.set(queue.guildId, queue);
        this.pumpUpdates();
    }

    private pumpUpdates(): void {
        while (this.updatesInFlight < this.maxConcurrentUpdates && this.pendingUpdates.size > 0) {
            const next = this.pendingUpdates.entries().next().value as [string, GuildQueue] | undefined;
            if (!next) return;
            const [guildId, queue] = next;
            this.pendingUpdates.delete(guildId);
            if (this.retryTimers.has(guildId) || queueManager.getQueue(guildId) !== queue) {
                continue;
            }
            this.updatesInFlight += 1;
            void this.updateNowPlaying(queue).finally(() => {
                this.updatesInFlight -= 1;
                this.pumpUpdates();
            });
        }
    }

    private scheduleRetry(queue: GuildQueue, error: unknown): void {
        if (this.retryTimers.has(queue.guildId) || queueManager.getQueue(queue.guildId) !== queue) {
            return;
        }

        const previousAttempts = this.retryAttempts.get(queue.guildId) ?? 0;
        if (previousAttempts >= this.maxRetryAttempts) {
            log.error('Abandon des mises à jour Now Playing après épuisement des retries', {
                guildId: queue.guildId,
                attempts: previousAttempts,
            });
            this.abandonNowPlayingUpdates(queue, error);
            return;
        }

        const attempt = previousAttempts + 1;
        this.retryAttempts.set(queue.guildId, attempt);
        this.pendingUpdates.delete(queue.guildId);
        const retryAfterSeconds = Number((error as { retry_after?: unknown })?.retry_after);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
        const exponentialMs = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempt - 1));
        const jitterMs = Math.floor(Math.random() * this.retryJitterMs);
        const delayMs = Math.max(retryAfterMs, exponentialMs + jitterMs);

        log.warn(`Mise à jour Now Playing différée de ${delayMs}ms`, {
            guildId: queue.guildId,
            attempt,
        });
        const timer = setTimeout(() => {
            this.retryTimers.delete(queue.guildId);
            if (queueManager.getQueue(queue.guildId) === queue) {
                this.scheduleUpdate(queue, true);
            }
        }, delayMs);
        timer.unref?.();
        this.retryTimers.set(queue.guildId, timer);
    }

    private getDiscordErrorCode(error: unknown): string | null {
        const candidate = error as {
            code?: number | string;
            rawError?: { code?: number | string };
        };
        const code = candidate?.code ?? candidate?.rawError?.code;
        return code === undefined || code === null ? null : String(code);
    }

    private isPermanentDiscordError(error: unknown): boolean {
        const candidate = error as { status?: number; statusCode?: number; httpStatus?: number };
        const status = candidate?.status ?? candidate?.statusCode ?? candidate?.httpStatus;
        if (status === 401 || status === 403) {
            return true;
        }

        const code = this.getDiscordErrorCode(error);
        return code !== null && ['10003', '10004', '10008', '50001', '50013'].includes(code);
    }

    private clearRetryState(guildId: string): void {
        const retryTimer = this.retryTimers.get(guildId);
        if (retryTimer) {
            clearTimeout(retryTimer);
            this.retryTimers.delete(guildId);
        }
        this.retryAttempts.delete(guildId);
    }

    private abandonNowPlayingUpdates(queue: GuildQueue, error: unknown): void {
        log.warn('Mises à jour Now Playing désactivées pour le message courant', {
            guildId: queue.guildId,
            code: this.getDiscordErrorCode(error),
        });
        queue.nowPlayingMessage = null;
        this.pendingUpdates.delete(queue.guildId);
        this.stopUpdateInterval(queue.guildId);
    }

    async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
        log.debug(`Bouton: ${interaction.customId}`);

        const guildId = interaction.guildId;
        if (!guildId) {
            return;
        }

        const locale = await resolveLocale(guildId, interaction.locale);
        const queue = queueManager.getQueue(guildId);
        if (!queue) {
            await interaction.reply({
                content: t(locale, 'queue.noQueue'),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            this.deleteEphemeralAfterDelay(interaction);
            return;
        }

        const member = interaction.member as GuildMember;
        if (!(await ensureCanUseBot(interaction, member))) {
            return;
        }

        const requiresSameVoiceChannel = ['np_pause', 'np_resume', 'np_skip', 'np_stop'].includes(interaction.customId);
        if (requiresSameVoiceChannel && !(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) {
            return;
        }

        switch (interaction.customId) {
            case 'np_pause':
                log.info('Pause via bouton');
                queueManager.pause(guildId);
                await this.updateNowPlaying(queue);
                await interaction.reply({
                    content: '⏸️',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_resume':
                log.info('Resume via bouton');
                queueManager.resume(guildId);
                await this.updateNowPlaying(queue);
                await interaction.reply({
                    content: '▶️',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_skip':
                log.info(`Skip via bouton: ${queue.currentTrack?.title}`);
                queueManager.skip(guildId);
                await interaction.reply({
                    content: '⏭️',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_stop':
                log.info('Stop via bouton');
                {
                    const settings = await guildSettingsManager.getSettings(guildId);
                    const shouldStay = settings.stayConnected || settings.stayConnectedAlways;
                    if (shouldStay) {
                        queueManager.stop(guildId);
                        await this.deleteNowPlaying(queue);
                    } else {
                        queueManager.deleteQueue(guildId, true);
                    }
                }
                await interaction.reply({
                    content: '⏹️',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_queue':
                await queueViewManager.show(interaction);
                break;

            case 'np_lyrics':
                if (!queue.currentTrack) {
                    await interaction.reply({
                        content: t(locale, 'lyrics.noTrack'),
                        flags: MessageFlags.Ephemeral,
                        allowedMentions: { parse: [] },
                    });
                    this.deleteEphemeralAfterDelay(interaction);
                    break;
                }
                await sendLyrics(interaction, buildTrackLyricsQuery(queue.currentTrack), queue);
                break;
        }
    }

    private async deleteEphemeralAfterDelay(interaction: ButtonInteraction): Promise<void> {
        const delayMs = Math.max(1, config.audio.ephemeralInfoDeleteDelay);
        setTimeout(async () => {
            try {
                await interaction.deleteReply();
            } catch {
                // Ignore
            }
        }, delayMs);
    }
}

export const nowPlayingManager = new NowPlayingManager();
