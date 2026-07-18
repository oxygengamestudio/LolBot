import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    GuildMember,
    Message,
    MessageFlags,
    ModalBuilder,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { queueManager } from './QueueManager.js';
import { config } from '../config.js';
import { resolveLocale, t } from '../utils/i18n.js';
import type { GuildQueue } from '../types/index.js';
import { safeContent } from '../utils/text.js';
import { ensureCanUseBot } from '../utils/commandHelpers.js';

interface QueueViewState {
    messageId: string;
    guildId: string;
    userId: string;
    locale: 'en' | 'fr';
    page: number;
    selectedIndex: number | null;
    timeout?: NodeJS.Timeout;
    deleteReply?: () => Promise<void>;
}

interface EphemeralReply {
    message: Message | null;
    deleteReply: (() => Promise<void>) | null;
}

type QueueInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction;

type QueueComponentRow =
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>;

interface QueueReplyPayload {
    content?: string;
    embeds?: EmbedBuilder[];
    components?: QueueComponentRow[];
}

class QueueViewManager {
    private views: Map<string, QueueViewState> = new Map();
    private activeByUser: Map<string, string> = new Map();
    private readonly pageSize = 10;
    private readonly maxPages = 10;

    async show(
        interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction
    ): Promise<void> {
        const guildId = interaction.guildId;
        if (!guildId) {
            return;
        }

        const locale = await resolveLocale(guildId, interaction.locale);
        const queue = queueManager.getQueue(guildId);
        if (!queue) {
            await this.replyInfo(interaction, t(locale, 'queue.noQueue'));
            return;
        }

        const userId = interaction.user.id;
        const userKey = this.getUserKey(guildId, userId);
        await this.clearExistingView(userKey);

        const state: QueueViewState = {
            messageId: '',
            guildId,
            userId,
            locale,
            page: 1,
            selectedIndex: null,
        };

        const payload = this.buildPayload(queue, state);
        const reply = await this.sendEphemeral(interaction, payload);
        if (reply.message) {
            state.messageId = reply.message.id;
            state.deleteReply = reply.deleteReply ?? undefined;
            this.views.set(state.messageId, state);
            this.activeByUser.set(userKey, state.messageId);
            this.scheduleDelete(state);
        }
    }

    async handleComponentInteraction(
        interaction: ButtonInteraction | StringSelectMenuInteraction
    ): Promise<void> {
        if (!interaction.inCachedGuild()) {
            return;
        }

        const member = interaction.member as GuildMember;
        if (!(await ensureCanUseBot(interaction, member))) {
            return;
        }

        const messageId = interaction.message.id;
        const state = await this.getState(messageId, interaction);
        if (!state) {
            const locale = await resolveLocale(interaction.guildId, interaction.locale);
            await this.replyInfo(interaction, t(locale, 'queue.invalidAction'));
            return;
        }

        const queue = queueManager.getQueue(state.guildId);
        if (!queue) {
            await this.replyInfo(interaction, t(state.locale, 'queue.noQueue'));
            this.views.delete(messageId);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'queue_select') {
            const selected = Number.parseInt(interaction.values[0] ?? '', 10);
            state.selectedIndex = Number.isNaN(selected) ? null : selected;
            await this.updateView(interaction, queue, state);
            return;
        }

        if (!interaction.isButton()) {
            return;
        }

        const { customId } = interaction;
        if (customId.startsWith('queue_page_')) {
            const page = Number.parseInt(customId.replace('queue_page_', ''), 10);
            state.page = Number.isNaN(page) ? state.page : page;
            await this.updateView(interaction, queue, state);
            return;
        }

        switch (customId) {
            case 'queue_delete_selected':
                if (state.selectedIndex === null) {
                    await this.replyInfo(interaction, t(state.locale, 'queue.noSelection'));
                    return;
                }
                queueManager.removeTrackAt(state.guildId, state.selectedIndex);
                state.selectedIndex = null;
                await this.updateView(interaction, queue, state);
                return;
            case 'queue_delete_page': {
                const { startIndex, endIndex } = this.getPageInfo(queue, state.page);
                queueManager.removeTracksRange(state.guildId, startIndex, endIndex);
                state.selectedIndex = null;
                await this.updateView(interaction, queue, state);
                return;
            }
            case 'queue_delete_all':
                queueManager.clearUpcoming(state.guildId);
                state.selectedIndex = null;
                state.page = 1;
                await this.updateView(interaction, queue, state);
                return;
            case 'queue_move':
                if (state.selectedIndex === null) {
                    await this.replyInfo(interaction, t(state.locale, 'queue.noSelection'));
                    return;
                }
                await this.showMoveModal(interaction, state.locale);
                return;
            default:
                return;
        }
    }

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        if (!interaction.customId.startsWith('queue_move:')) {
            return;
        }

        if (!interaction.inCachedGuild()) {
            return;
        }

        const member = interaction.member as GuildMember;
        if (!(await ensureCanUseBot(interaction, member))) {
            return;
        }

        const messageId = interaction.customId.split(':')[1];
        const state = messageId ? this.views.get(messageId) : null;
        if (!state) {
            const locale = await resolveLocale(interaction.guildId, interaction.locale);
            await this.replyInfo(interaction, t(locale, 'queue.invalidAction'));
            return;
        }

        state.locale = await resolveLocale(state.guildId, interaction.locale);

        const queue = queueManager.getQueue(state.guildId);
        if (!queue) {
            await this.replyInfo(interaction, t(state.locale, 'queue.noQueue'));
            this.views.delete(messageId);
            return;
        }

        if (state.selectedIndex === null) {
            await this.replyInfo(interaction, t(state.locale, 'queue.noSelection'));
            return;
        }

        const input = interaction.fields.getTextInputValue('queue_move_position').trim().toLowerCase();
        const target = this.parseMoveTarget(input, queue.tracks.length);
        if (target === null) {
            await this.replyInfo(interaction, t(state.locale, 'queue.invalidMove'));
            return;
        }

        queueManager.moveTrack(state.guildId, state.selectedIndex, target);
        state.selectedIndex = target;
        state.page = Math.floor(target / this.pageSize) + 1;

        await this.clearExistingView(this.getUserKey(state.guildId, state.userId));
        await this.show(interaction);
    }

    private parseMoveTarget(input: string, length: number): number | null {
        if (length === 0) return null;
        if (['start', 'debut', 'first'].includes(input)) return 0;
        if (['end', 'fin', 'last'].includes(input)) return length - 1;

        const asNumber = Number.parseInt(input, 10);
        if (Number.isNaN(asNumber)) return null;

        const clamped = Math.max(1, Math.min(asNumber, length));
        return clamped - 1;
    }

    private async showMoveModal(interaction: ButtonInteraction, locale: 'en' | 'fr'): Promise<void> {
        const modal = new ModalBuilder()
            .setCustomId(`queue_move:${interaction.message.id}`)
            .setTitle(t(locale, 'queue.moveTitle'));

        const input = new TextInputBuilder()
            .setCustomId('queue_move_position')
            .setLabel(t(locale, 'queue.moveLabel'))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t(locale, 'queue.movePlaceholder'))
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
    }

    private async getState(
        messageId: string,
        interaction: ButtonInteraction | StringSelectMenuInteraction
    ): Promise<QueueViewState | null> {
        const existing = this.views.get(messageId);
        if (existing) {
            if (existing.userId !== interaction.user.id) {
                return null;
            }
            existing.locale = await resolveLocale(existing.guildId, interaction.locale);
            return existing;
        }

        const state: QueueViewState = {
            messageId,
            guildId: interaction.guildId ?? '',
            userId: interaction.user.id,
            locale: await resolveLocale(interaction.guildId, interaction.locale),
            page: 1,
            selectedIndex: null,
        };

        this.views.set(messageId, state);
        this.activeByUser.set(this.getUserKey(state.guildId, state.userId), messageId);
        return state;
    }

    private async updateView(
        interaction: ButtonInteraction | StringSelectMenuInteraction,
        queue: GuildQueue,
        state: QueueViewState
    ): Promise<void> {
        this.normalizeState(queue, state);
        const payload = this.buildPayload(queue, state);
        await interaction.update({
            ...payload,
            allowedMentions: { parse: [] },
        });
        state.messageId = interaction.message.id;
        state.deleteReply = async () => {
            try {
                await interaction.deleteReply();
            } catch {
                // Ignore
            }
        };
        this.views.set(state.messageId, state);
        this.activeByUser.set(this.getUserKey(state.guildId, state.userId), state.messageId);
        this.scheduleDelete(state);
    }

    private normalizeState(queue: GuildQueue, state: QueueViewState): void {
        const totalPages = this.getTotalPages(queue);
        state.page = Math.max(1, Math.min(state.page, totalPages));
        if (state.selectedIndex !== null && state.selectedIndex >= queue.tracks.length) {
            state.selectedIndex = null;
        }
    }

    private buildPayload(queue: GuildQueue, state: QueueViewState): QueueReplyPayload {
        const embed = this.buildEmbed(queue, state);
        const components = this.buildComponents(queue, state);
        return { embeds: [embed], components };
    }

    private buildEmbed(queue: GuildQueue, state: QueueViewState): EmbedBuilder {
        const { pageTracks, totalPages, safePage, startIndex } = this.getPageInfo(queue, state.page);
        const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle(`📋 ${t(state.locale, 'queue.title', { page: safePage, pages: totalPages })}`)
            .setFooter({ text: `📋 ${t(state.locale, 'queue.footer', { count: queue.tracks.length })}` });

        if (queue.currentTrack) {
            const currentTime = queueManager.getCurrentTime(queue.guildId);
            const timeString = `${this.formatTime(currentTime)} / ${this.formatTime(queue.currentTrack.duration)}`;
            const statusIcon = queue.isPaused ? '⏸️' : '▶️';
            embed.addFields({
                name: statusIcon,
                value: `**${safeContent(this.truncateString(queue.currentTrack.title, 80))}** • \`${timeString}\` • 👤 <@${queue.currentTrack.requestedById}>`,
                inline: false,
            });
        }

        if (pageTracks.length > 0) {
            const list = pageTracks
                .map((track, index) => {
                    const position = startIndex + index + 1;
                    return `**${position}.** ${this.truncateString(track.title, 68)} • \`${this.formatTime(track.duration)}\` • 👤 <@${track.requestedById}>`;
                })
                .join('\n');
            embed.setDescription(this.fitEmbedDescription(`**${t(state.locale, 'queue.listTitle')}**\n${list}`));
        } else {
            embed.setDescription(t(state.locale, 'queue.empty'));
        }

        embed.addFields({
            name: t(state.locale, 'queue.controlsTitle'),
            value: t(state.locale, 'queue.controlsText'),
            inline: false,
        });

        return embed;
    }

    private buildComponents(queue: GuildQueue, state: QueueViewState): QueueComponentRow[] {
        const components: QueueComponentRow[] = [];
        const { pageTracks, totalPages, safePage, startIndex } = this.getPageInfo(queue, state.page);

        if (pageTracks.length > 0) {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('queue_select')
                .setPlaceholder(t(state.locale, 'queue.selectPlaceholder'))
                .addOptions(
                    pageTracks.map((track, index) => {
                        const absoluteIndex = startIndex + index;
                        const option = new StringSelectMenuOptionBuilder()
                            .setLabel(this.truncateString(`${absoluteIndex + 1}. ${track.title}`, 100))
                            .setDescription(this.truncateString(`⏱️ ${this.formatTime(track.duration)} • 👤 ${track.requestedBy}`, 100))
                            .setValue(String(absoluteIndex));
                        if (state.selectedIndex === absoluteIndex) {
                            option.setDefault(true);
                        }
                        return option;
                    })
                );

            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
        }

        if (totalPages > 1) {
            const buttons: ButtonBuilder[] = [];
            for (let page = 1; page <= totalPages; page += 1) {
                const button = new ButtonBuilder()
                    .setCustomId(`queue_page_${page}`)
                    .setLabel(`${page}`)
                    .setStyle(page === safePage ? ButtonStyle.Primary : ButtonStyle.Secondary);
                buttons.push(button);
            }

            for (let i = 0; i < buttons.length; i += 5) {
                components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
            }
        }

        const deleteSelected = new ButtonBuilder()
            .setCustomId('queue_delete_selected')
            .setEmoji('🗑️')
            .setLabel(t(state.locale, 'queue.btnDeleteSelected'))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(state.selectedIndex === null);

        const deletePage = new ButtonBuilder()
            .setCustomId('queue_delete_page')
            .setEmoji('🧹')
            .setLabel(t(state.locale, 'queue.btnDeletePage'))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(pageTracks.length === 0);

        const deleteAll = new ButtonBuilder()
            .setCustomId('queue_delete_all')
            .setEmoji('💥')
            .setLabel(t(state.locale, 'queue.btnDeleteAll'))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(queue.tracks.length === 0);

        const move = new ButtonBuilder()
            .setCustomId('queue_move')
            .setEmoji('↕️')
            .setLabel(t(state.locale, 'queue.btnMove'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(state.selectedIndex === null);

        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(deleteSelected, deletePage, deleteAll, move));

        return components;
    }

    private getPageInfo(queue: GuildQueue, page: number) {
        const totalPages = this.getTotalPages(queue);
        const safePage = Math.max(1, Math.min(page, totalPages));
        const startIndex = (safePage - 1) * this.pageSize;
        const endIndex = startIndex + this.pageSize;
        const pageTracks = queue.tracks.slice(startIndex, endIndex);
        return { totalPages, safePage, startIndex, endIndex, pageTracks };
    }

    private getTotalPages(queue: GuildQueue): number {
        const totalTracks = queue.tracks.length;
        const totalPages = Math.max(1, Math.ceil(totalTracks / this.pageSize));
        return Math.min(totalPages, this.maxPages);
    }

    private fitEmbedDescription(text: string): string {
        const maxLength = 4096;
        if (text.length <= maxLength) {
            return text;
        }

        return `${text.slice(0, maxLength - 3).trimEnd()}...`;
    }

    private scheduleDelete(state: QueueViewState): void {
        if (state.timeout) {
            clearTimeout(state.timeout);
        }
        const delayMs = Math.max(1, config.audio.ephemeralInteractiveDeleteDelay);
        state.timeout = setTimeout(async () => {
            if (state.deleteReply) {
                try {
                    await state.deleteReply();
                } catch {
                    // Ignore
                }
            }
            this.views.delete(state.messageId);
            this.activeByUser.delete(this.getUserKey(state.guildId, state.userId));
        }, delayMs);
    }

    private async clearExistingView(userKey: string): Promise<void> {
        const existingId = this.activeByUser.get(userKey);
        if (!existingId) {
            return;
        }
        const existing = this.views.get(existingId);
        if (existing?.timeout) {
            clearTimeout(existing.timeout);
        }
        if (existing?.deleteReply) {
            try {
                await existing.deleteReply();
            } catch {
                // Ignore
            }
        }
        this.views.delete(existingId);
        this.activeByUser.delete(userKey);
    }

    private getUserKey(guildId: string, userId: string): string {
        return `${guildId}:${userId}`;
    }

    private async replyInfo(
        interaction: QueueInteraction,
        content: string
    ): Promise<void> {
        const reply = await this.sendEphemeral(interaction, { content });
        if (reply.deleteReply) {
            const delayMs = Math.max(1, config.audio.ephemeralInfoDeleteDelay);
            setTimeout(() => {
                reply.deleteReply?.().catch(() => {});
            }, delayMs);
        }
    }

    private async sendEphemeral(
        interaction: QueueInteraction,
        payload: QueueReplyPayload
    ): Promise<EphemeralReply> {
        if (interaction.deferred) {
            await interaction.editReply({
                ...payload,
                allowedMentions: { parse: [] },
            });
            const message = await interaction.fetchReply().catch(() => null);
            return {
                message,
                deleteReply: async () => {
                    try {
                        await interaction.deleteReply();
                    } catch {
                        // Ignore
                    }
                },
            };
        }

        if (interaction.replied) {
            const message = await interaction.followUp({
                ...payload,
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
                allowedMentions: { parse: [] },
            });
            const msg = message as Message;
            return {
                message: msg,
                deleteReply: async () => {
                    try {
                        await interaction.webhook.deleteMessage(msg.id);
                    } catch {
                        // Ignore
                    }
                },
            };
        }

        await interaction.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        const message = await interaction.fetchReply().catch(() => null);
        return {
            message,
            deleteReply: async () => {
                try {
                    await interaction.deleteReply();
                } catch {
                    // Ignore
                }
            },
        };
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

    private truncateString(str: string, maxLength: number): string {
        const sanitized = safeContent(str);
        if (sanitized.length <= maxLength) return sanitized;
        return sanitized.substring(0, maxLength - 3) + '...';
    }
}

export const queueViewManager = new QueueViewManager();
