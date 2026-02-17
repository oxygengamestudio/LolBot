import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags, TextChannel } from 'discord.js';
import type { Collection, Message } from 'discord.js';
import { canManageSettings } from '../utils/permissions.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import { queueManager } from '../services/QueueManager.js';

const log = logger.createModuleLogger('ClearCmd');

export const data = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Supprime les messages du bot dans ce canal (Administrateurs uniquement)')
    .addStringOption((option) =>
        option
            .setName('count')
            .setDescription("Nombre de messages à supprimer ('all' ou un nombre)")
            .setRequired(false)
    )
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.member as GuildMember;

    if (!(await canManageSettings(member))) {
        await interaction.reply({
            content: '❌ Vous devez être administrateur pour utiliser cette commande.',
            flags: MessageFlags.Ephemeral,
        });
        setTimeout(async () => {
            try { await interaction.deleteReply(); } catch {}
        }, config.audio.ephemeralInfoDeleteDelay);
        return;
    }

    const rawCount = interaction.options.getString('count')?.trim();
    let maxToDelete = Number.POSITIVE_INFINITY;

    if (rawCount && rawCount.toLowerCase() !== 'all') {
        const parsed = Number.parseInt(rawCount, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            await interaction.reply({
                content: '❌ Valeur invalide. Utilisez `all` ou un nombre positif.',
                flags: MessageFlags.Ephemeral,
            });
            setTimeout(async () => {
                try { await interaction.deleteReply(); } catch {}
            }, config.audio.ephemeralInfoDeleteDelay);
            return;
        }
        maxToDelete = parsed;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const channel = interaction.channel as TextChannel;
        let deletedCount = 0;
        let lastMessageId: string | undefined = undefined;
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
                    deletedCount++;
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch {
                    log.trace('Message non supprimable (trop ancien ou déjà supprimé)');
                }
            }

            lastMessageId = messages.last()?.id;

            if (messages.size < 100) break;
        }

        log.info(`${deletedCount} message(s) supprimé(s)`);

        await interaction.editReply({
            content: `🧹 **${deletedCount}** message(s) du bot supprimé(s) dans ce canal.`,
        });

        setTimeout(async () => {
            try { await interaction.deleteReply(); } catch {}
        }, config.audio.ephemeralInfoDeleteDelay);
    } catch (error) {
        log.error('Erreur lors du nettoyage:', error);
        await interaction.editReply({
            content: '❌ Erreur lors de la suppression des messages.',
        });
    }
}


