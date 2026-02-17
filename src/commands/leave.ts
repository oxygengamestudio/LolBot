import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('LeaveCmd');

export const data = new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Déconnecte le bot du canal vocal')
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
        });
        return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    log.debug(`Commande leave par ${member.user.tag}`);

    if (!voiceChannel) {
        await interaction.reply({
            content: '❌ Vous devez être dans un canal vocal pour utiliser cette commande.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const queue = queueManager.getQueue(interaction.guildId!);

    if (!queue) {
        await interaction.reply({
            content: '❌ Le bot n\'est pas connecté.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    if (queue.voiceChannel.id !== voiceChannel.id) {
        await interaction.reply({
            content: '❌ Vous devez être dans le même canal vocal que le bot.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.info('Déconnexion via /leave');
    queueManager.deleteQueue(interaction.guildId!);
    await interaction.reply({
        content: '👋 Bot déconnecté.',
        flags: MessageFlags.Ephemeral,
    });
    deleteEphemeralAfterDelay(interaction);
}

async function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): Promise<void> {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            // Ignorer
        }
    }, config.audio.ephemeralInfoDeleteDelay);
}
