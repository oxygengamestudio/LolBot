import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ColorResolvable,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import { queueManager } from './QueueManager.js';
import { queueViewManager } from './QueueViewManager.js';
import { sendLyrics } from '../utils/lyrics.js';
import { config } from '../config.js';
import { t } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { guildSettingsManager } from './GuildSettingsManager.js';
import type { GuildQueue } from '../types/index.js';

const log = logger.createModuleLogger('NowPlaying');

class NowPlayingManager {
    private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
    private readonly COLORS = {
        playing: 0x1DB954 as ColorResolvable,
        paused: 0xFFA500 as ColorResolvable,
        idle: 0x808080 as ColorResolvable,
    };

    constructor() {
        log.info('NowPlayingManager initialise');

        queueManager.on('trackStart', (queue: GuildQueue) => this.onTrackStart(queue));
        queueManager.on('trackEnd', (queue: GuildQueue) => this.onTrackEnd(queue));
        queueManager.on('trackPaused', (queue: GuildQueue) => this.updateNowPlaying(queue));
        queueManager.on('queueStopped', (queue: GuildQueue) => this.deleteNowPlaying(queue));
        queueManager.on('queueEmpty', (queue: GuildQueue) => this.deleteNowPlaying(queue));
        queueManager.on('queueDeleted', (guildId: string) => this.stopUpdateInterval(guildId));
    }

    private async onTrackStart(queue: GuildQueue): Promise<void> {
        log.debug(`Track start: ${queue.currentTrack?.title}`);
        await this.createOrUpdateNowPlaying(queue);
        this.startUpdateInterval(queue);
    }

    private async onTrackEnd(queue: GuildQueue): Promise<void> {
        log.debug('Track end');
        // The next track start or queue empty will handle updates/deletion.
    }

    async createOrUpdateNowPlaying(queue: GuildQueue): Promise<void> {
        if (!queue.currentTrack) {
            log.trace('Pas de track actuel, skip');
            return;
        }

        const embed = this.createEmbed(queue);
        const row = this.createButtons(queue);

        try {
            if (queue.nowPlayingMessage) {
                log.trace('Mise a jour du message Now Playing existant');
                await queue.nowPlayingMessage.edit({
                    embeds: [embed],
                    components: [row],
                });
            } else {
                log.debug('Creation d\'un nouveau message Now Playing');
                const message = await queue.textChannel.send({
                    embeds: [embed],
                    components: [row],
                });
                queue.nowPlayingMessage = message;
                log.info('Message Now Playing cree');
            }
        } catch (error) {
            log.error('Erreur lors de la mise a jour:', error);
            if (queue.nowPlayingMessage) {
                queue.nowPlayingMessage = null;
                await this.createOrUpdateNowPlaying(queue);
            }
        }
    }

    async updateNowPlaying(queue: GuildQueue): Promise<void> {
        if (!queue.nowPlayingMessage || !queue.currentTrack) return;

        const embed = this.createEmbed(queue);
        const row = this.createButtons(queue);

        try {
            await queue.nowPlayingMessage.edit({
                embeds: [embed],
                components: [row],
            });
        } catch (error) {
            log.trace('Message supprime, reset');
            queue.nowPlayingMessage = null;
        }
    }

    async deleteNowPlaying(queue: GuildQueue): Promise<void> {
        log.debug('Suppression du message Now Playing');
        this.stopUpdateInterval(queue.guildId);

        if (queue.nowPlayingMessage) {
            try {
                await queue.nowPlayingMessage.delete();
                log.info('Message Now Playing supprime');
            } catch (error) {
                log.trace('Message deja supprime');
            }
            queue.nowPlayingMessage = null;
        }
    }

    private createEmbed(queue: GuildQueue): EmbedBuilder {
        const track = queue.currentTrack!;
        const currentTime = queueManager.getCurrentTime(queue.guildId);
        const progress = this.createProgressBar(currentTime, track.duration);
        const currentTimeString = this.formatTime(currentTime);
        const totalTimeString = this.formatTime(track.duration);

        const color = queue.isPaused ? this.COLORS.paused : this.COLORS.playing;
        const statusLabel = queue.isPaused ? '⏸️ En pause' : '▶️ Lecture en cours';
        const squareCover = this.getSquareThumbnail(track.thumbnail);
        const largeCover = this.getLargeCover(track.thumbnail);

        const embed = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: statusLabel })
            .setTitle(track.title)
            .setURL(track.url)
            .setDescription(`\`${currentTimeString}\` ${progress} \`${totalTimeString}\``)
            .addFields(
                {
                    name: 'Informations',
                    value: [
                        `👤 <@${track.requestedById}>`,
                        `📋 ${queue.tracks.length} en attente`,
                        `🔊 ${queue.volume}%`,
                    ].join('\n'),
                    inline: true,
                },
                {
                    name: 'Miniature',
                    value: largeCover ? 'Voir image ci-dessous' : 'Indisponible',
                    inline: true,
                }
            )
            .setFooter({
                text: queue.isPaused ? 'Lecture en pause' : 'Lecture active',
            });

        if (squareCover) {
            embed.setThumbnail(squareCover);
        }
        if (largeCover) {
            embed.setImage(largeCover);
        }

        return embed;
    }

    private createButtons(queue: GuildQueue): ActionRowBuilder<ButtonBuilder> {
        const playPauseButton = new ButtonBuilder()
            .setCustomId(queue.isPaused ? 'np_resume' : 'np_pause')
            .setEmoji(queue.isPaused ? '▶️' : '⏸️')
            .setLabel(queue.isPaused ? 'Reprendre' : 'Pause')
            .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);

        const skipButton = new ButtonBuilder()
            .setCustomId('np_skip')
            .setEmoji('⏭️')
            .setLabel('Passer')
            .setStyle(ButtonStyle.Primary);

        const queueButton = new ButtonBuilder()
            .setCustomId('np_queue')
            .setEmoji('📋')
            .setLabel('File')
            .setStyle(ButtonStyle.Secondary);

        const lyricsButton = new ButtonBuilder()
            .setCustomId('np_lyrics')
            .setEmoji('🎤')
            .setLabel('Paroles')
            .setStyle(ButtonStyle.Secondary);

        const stopButton = new ButtonBuilder()
            .setCustomId('np_stop')
            .setEmoji('⏹️')
            .setLabel('Stop')
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
            if (i < filled) {
                bar += '▰';
            } else {
                bar += '▱';
            }
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

            // Crop centré carré pour les miniatures YouTube
            // afin d'obtenir un rendu type "pochette d'album".
            if (host.endsWith('ytimg.com') || host.endsWith('youtube.com') || host.endsWith('youtu.be')) {
                const source = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
                const params = new URLSearchParams({
                    url: source,
                    w: '512',
                    h: '512',
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

    private getLargeCover(url: string): string {
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
                    w: '1280',
                    h: '720',
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
                this.updateNowPlaying(currentQueue);
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
    }

    async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
        log.debug(`Bouton: ${interaction.customId}`);

        const guildId = interaction.guildId;
        if (!guildId) {
            return;
        }

        const queue = queueManager.getQueue(guildId);
        if (!queue) {
            await interaction.reply({
                content: t(interaction.locale, 'queue.noQueue'),
                flags: MessageFlags.Ephemeral,
            });
            this.deleteEphemeralAfterDelay(interaction);
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
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_skip':
                log.info(`Skip via bouton: ${queue.currentTrack?.title}`);
                queueManager.skip(guildId);
                await interaction.reply({
                    content: '⏭️',
                    flags: MessageFlags.Ephemeral,
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
                        queueManager.deleteQueue(guildId);
                    }
                }
                await interaction.reply({
                    content: '⏹️',
                    flags: MessageFlags.Ephemeral,
                });
                this.deleteEphemeralAfterDelay(interaction);
                break;

            case 'np_queue':
                await queueViewManager.show(interaction);
                break;

            case 'np_lyrics':
                if (!queue.currentTrack) {
                    await interaction.reply({
                        content: t(interaction.locale, 'lyrics.noTrack'),
                        flags: MessageFlags.Ephemeral,
                    });
                    this.deleteEphemeralAfterDelay(interaction);
                    break;
                }
                await sendLyrics(interaction, queue.currentTrack.title, queue);
                break;
        }
    }

    private async deleteEphemeralAfterDelay(interaction: ButtonInteraction): Promise<void> {
        setTimeout(async () => {
            try {
                await interaction.deleteReply();
            } catch {
                // Ignore
            }
        }, config.audio.ephemeralInfoDeleteDelay);
    }
}

export const nowPlayingManager = new NowPlayingManager();
