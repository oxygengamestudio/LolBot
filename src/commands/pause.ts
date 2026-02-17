import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { checkBasicPermissions, deleteEphemeralAfterDelay } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('PauseCmd');

export const data = new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Met en pause la musique en cours')
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

    log.debug(`Commande pause par ${member.user.tag}`);

    if (!(await checkBasicPermissions(interaction, member))) {
        return;
    }

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

    if (queue.isPaused) {
        await interaction.reply({
            content: '⏸️ La musique est déjà en pause. Utilisez `/resume` pour reprendre.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const success = queueManager.pause(interaction.guildId!);

    if (success) {
        log.info(`Pause: ${queue.currentTrack?.title}`);
        await interaction.reply({
            content: `⏸️ **${queue.currentTrack?.title}** mise en pause.`,
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await interaction.reply({
            content: '❌ Impossible de mettre en pause.',
            flags: MessageFlags.Ephemeral,
        });
    }
    deleteEphemeralAfterDelay(interaction);
}

