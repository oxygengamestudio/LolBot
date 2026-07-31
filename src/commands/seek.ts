import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import {
    ensureCanUseBot,
    ensureSameVoiceChannel,
    ensureVoiceMembership,
    getInteractionLocale,
    replyEphemeral,
    scheduleDeleteReply,
} from '../utils/commandHelpers.js';

export const data = new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Move playback forward or backward')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Avance ou recule la lecture de X secondes', 'Move playback forward or backward'))
    .setDMPermission(false)
    .addIntegerOption((option) =>
        option
            .setName('seconds')
            .setDescription('Seconds to move (positive or negative)')
            .setDescriptionLocalizations(commandDescriptionLocalizations('Nombre de secondes (positif ou negatif)', 'Seconds to move (positive or negative)'))
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    if (!(await ensureCanUseBot(interaction, member))) {
        return;
    }
    if (!(await ensureVoiceMembership(interaction, member))) {
        return;
    }

    const seconds = interaction.options.getInteger('seconds', true);
    const guildId = interaction.guildId!;
    const queue = queueManager.getQueue(guildId);

    if (!queue?.currentTrack) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.noTrack')}`);
        return;
    }
    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) {
        return;
    }

    if (!Number.isFinite(queue.currentTrack.duration) || queue.currentTrack.duration <= 0) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'seek.unavailable')}`);
        return;
    }

    const current = queueManager.getCurrentTime(guildId);
    const target = current + seconds;

    await interaction.deferReply({ flags: 64 });

    const ok = await queueManager.seekTo(guildId, target);
    if (!ok) {
        await interaction.editReply({
            content: `❌ ${t(locale, 'seek.failed')}`,
            allowedMentions: { parse: [] },
        });
        scheduleDeleteReply(interaction);
        return;
    }

    const delta = `${seconds >= 0 ? '+' : ''}${seconds}s`;
    await interaction.editReply({
        content: `✅ ${t(locale, 'seek.success', { delta, position: `${Math.max(0, target)}s` })}`,
        allowedMentions: { parse: [] },
    });
    scheduleDeleteReply(interaction);
}
