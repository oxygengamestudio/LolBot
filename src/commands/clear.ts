import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags, TextChannel } from 'discord.js';
import type { Collection, Message } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanManageSettings, getInteractionLocale, replyEphemeral, scheduleDeleteReply } from '../utils/commandHelpers.js';

const log = logger.createModuleLogger('ClearCmd');

export const data = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete bot messages in this channel')
    .setDescriptionLocalizations(
        commandDescriptionLocalizations(
            'Supprime les messages du bot dans ce canal',
            'Delete bot messages in this channel'
        )
    )
    .addStringOption((option) =>
        option
            .setName('count')
            .setDescription('How many messages to delete (`all` or a positive number)')
            .setDescriptionLocalizations(
                commandDescriptionLocalizations(
                    'Nombre de messages a supprimer (`all` ou un nombre positif)',
                    'How many messages to delete (`all` or a positive number)'
                )
            )
            .setRequired(false)
    )
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const locale = await getInteractionLocale(interaction);
    const member = interaction.member as GuildMember;
    if (!(await ensureCanManageSettings(interaction, member))) {
        return;
    }

    const rawCount = interaction.options.getString('count')?.trim();
    let maxToDelete = Number.POSITIVE_INFINITY;

    if (rawCount && rawCount.toLowerCase() !== 'all') {
        const parsed = Number.parseInt(rawCount, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            await replyEphemeral(interaction, `❌ ${t(locale, 'clear.invalidCount')}`);
            return;
        }
        maxToDelete = parsed;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const channel = interaction.channel as TextChannel;
        let deletedCount = 0;
        let lastMessageId: string | undefined;
        let protectedMessageId: string | undefined;

        const queue = queueManager.getQueue(interaction.guildId!);
        if (queue?.isPlaying && queue.nowPlayingMessage && queue.nowPlayingMessage.channel?.id === channel.id) {
            protectedMessageId = queue.nowPlayingMessage.id;
        }

        log.info(`Nettoyage des messages du bot dans ${channel.name}`);

        while (deletedCount < maxToDelete) {
            const options: { limit: number; before?: string } = lastMessageId
                ? { limit: 100, before: lastMessageId }
                : { limit: 100 };

            const messages = (await channel.messages.fetch(options)) as Collection<string, Message<true>>;
            if (messages.size === 0) break;

            const botMessages = messages.filter(
                (msg) =>
                    msg.author.id === interaction.client.user.id &&
                    (!protectedMessageId || msg.id !== protectedMessageId)
            );

            for (const msg of botMessages.values()) {
                if (deletedCount >= maxToDelete) break;
                try {
                    await msg.delete();
                    deletedCount += 1;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                } catch {
                    log.trace('Message non supprimable (trop ancien ou deja supprime)');
                }
            }

            lastMessageId = messages.last()?.id;

            if (messages.size < 100) break;
        }

        log.info(`${deletedCount} message(s) supprime(s)`);

        await interaction.editReply({
            content: `🧹 ${t(locale, 'clear.deleted', { count: deletedCount })}`,
            allowedMentions: { parse: [] },
        });

        scheduleDeleteReply(interaction, config.audio.ephemeralInfoDeleteDelay);
    } catch (error) {
        log.error('Erreur lors du nettoyage:', error);
        await interaction.editReply({
            content: `❌ ${t(locale, 'clear.failed')}`,
            allowedMentions: { parse: [] },
        });
    }
}
