import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { canUseBot } from '../utils/permissions.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Avance ou recule la lecture de X secondes')
    .setDMPermission(false)
    .addIntegerOption(option =>
        option
            .setName('seconds')
            .setDescription('Nombre de secondes (positif ou négatif)')
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.member as GuildMember;
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: '❌ Vous n\'avez pas la permission d\'utiliser ce bot.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const seconds = interaction.options.getInteger('seconds', true);
    const guildId = interaction.guildId!;
    const queue = queueManager.getQueue(guildId);

    if (!queue || !queue.currentTrack) {
        await interaction.reply({
            content: '❌ Aucune musique en cours.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (!Number.isFinite(queue.currentTrack.duration) || queue.currentTrack.duration <= 0) {
        await interaction.reply({
            content: '❌ Cette piste ne permet pas le seek.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const current = queueManager.getCurrentTime(guildId);
    const target = current + seconds;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ok = await queueManager.seekTo(guildId, target);
    if (!ok) {
        await interaction.editReply({ content: '❌ Impossible de déplacer la lecture.' });
        return;
    }

    const sign = seconds >= 0 ? '+' : '';
    await interaction.editReply({
        content: `✅ Lecture déplacée: ${sign}${seconds}s (position: ${Math.max(0, target)}s)`
    });

    setTimeout(async () => {
        try { await interaction.deleteReply(); } catch {}
    }, config.audio.ephemeralInfoDeleteDelay);
}
