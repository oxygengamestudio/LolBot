import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, ensureSameVoiceChannel, ensureVoiceMembership, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';
import { safeContent } from '../utils/text.js';

const log = logger.createModuleLogger('ResumeCmd');

export const data = new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume playback')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Reprend la lecture de la musique', 'Resume playback'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    log.debug(`Commande resume par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) return;
    if (!(await ensureVoiceMembership(interaction, member))) return;

    const queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.noQueue')}`);
        return;
    }
    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) return;

    if (!queue.isPaused) {
        await replyEphemeral(interaction, `▶️ ${t(locale, 'resume.notPaused')}`);
        return;
    }

    const success = queueManager.resume(interaction.guildId!);
    if (success) {
        log.info(`Resume: ${queue.currentTrack?.title}`);
        await replyEphemeral(interaction, `▶️ ${t(locale, 'resume.success', { title: safeContent(queue.currentTrack?.title ?? '') })}`);
        return;
    }

    await replyEphemeral(interaction, `❌ ${t(locale, 'resume.failed')}`);
}
