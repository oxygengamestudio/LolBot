import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { canUseBot, canJoinVoiceChannel } from '../utils/permissions.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('JoinCmd');

export const data = new SlashCommandBuilder()
    .setName('join')
    .setDescription('Rejoint le canal vocal')
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

    log.debug(`Commande join par ${member.user.tag}`);

    // Vérification permissions
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: '❌ Vous n\'avez pas la permission d\'utiliser ce bot.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);

    // Déterminer le channel à rejoindre
    let targetChannel = null;

    if (settings.preferredVoiceChannel) {
        const preferredChannel = member.guild.channels.cache.get(settings.preferredVoiceChannel);
        if (preferredChannel && (preferredChannel.isVoiceBased())) {
            targetChannel = preferredChannel;
            log.debug(`Utilisation du preferred channel: ${preferredChannel.name}`);
        } else {
            log.warn(`Preferred channel ${settings.preferredVoiceChannel} introuvable ou invalide`);
        }
    }

    if (!targetChannel) {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            await interaction.reply({
                content: '❌ Vous devez être dans un canal vocal ou configurer un canal préféré.',
                flags: MessageFlags.Ephemeral,
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }
        targetChannel = voiceChannel;
    }

    // Vérifier si le channel est autorisé
    if (!(await canJoinVoiceChannel(targetChannel, interaction.guildId!))) {
        await interaction.reply({
            content: `❌ Je n'ai pas l'autorisation de rejoindre <#${targetChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    // Vérifier si déjà connecté
    const existingQueue = queueManager.getQueue(interaction.guildId!);
    if (existingQueue && existingQueue.connection) {
        await interaction.reply({
            content: `✅ Déjà connecté à <#${existingQueue.voiceChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    // Créer la queue sans piste
    const queue = queueManager.createQueue(
        interaction.guildId!,
        interaction.channel as any,
        targetChannel
    );

    try {
        const connection = await queueManager.joinChannel(queue);
        if (!connection) {
            await interaction.reply({
                content: '❌ Impossible de rejoindre le canal vocal.',
                flags: MessageFlags.Ephemeral,
            });
            deleteEphemeralAfterDelay(interaction);
            queueManager.deleteQueue(interaction.guildId!);
            return;
        }

        log.info(`Bot rejoint le canal: ${targetChannel.name}`);
        await interaction.reply({
            content: `✅ Connecté à <#${targetChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
    } catch (error) {
        log.error('Erreur lors de la connexion:', error);
        await interaction.reply({
            content: '❌ Erreur lors de la connexion au canal vocal.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        queueManager.deleteQueue(interaction.guildId!);
    }
}

async function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): Promise<void> {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignorer
        }
    }, config.audio.ephemeralInfoDeleteDelay);
}
