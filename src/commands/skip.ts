import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('SkipCmd');

export const data = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Passe à la musique suivante')
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

    log.debug(`Commande skip par ${member.user.tag}`);

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

    const skippedTrack = queue.currentTrack?.title;
    const nextTrack = queue.tracks[0];

    log.info(`Skip: ${skippedTrack}`);
    const success = queueManager.skip(interaction.guildId!);

    if (success) {
        let message = `⏭️ Piste passée: **${skippedTrack}**`;
        if (nextTrack) {
            message += `\n▶️ Prochaine piste: **${nextTrack.title}**`;
        } else {
            message += '\n📋 File d\'attente terminée.';
        }
        await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await interaction.reply({
            content: '❌ Impossible de passer à la piste suivante.',
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

