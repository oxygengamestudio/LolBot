import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('StopCmd');

export const data = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Arrête la musique et vide la file d\'attente')
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

    log.debug(`Commande stop par ${member.user.tag}`);

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
            content: '❌ Aucune musique en cours de lecture.',
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

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);
    const shouldStay = settings.stayConnected || settings.stayConnectedAlways;

    if (shouldStay) {
        log.info('Arrêt de la lecture (bot reste connecté)');
        queueManager.stop(interaction.guildId!);
        await interaction.reply({
            content: '⏹️ Lecture arrêtée. Le bot reste connecté.',
            flags: MessageFlags.Ephemeral,
        });
    } else {
        log.info('Arrêt de la lecture et déconnexion');
        queueManager.deleteQueue(interaction.guildId!);
        await interaction.reply({
            content: '⏹️ Lecture arrêtée et bot déconnecté.',
            flags: MessageFlags.Ephemeral,
        });
    }

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
