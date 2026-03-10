import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, ensureSameVoiceChannel, ensureVoiceMembership, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';
import { safeContent } from '../utils/text.js';

const log = logger.createModuleLogger('PauseCmd');

export const data = new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Met en pause la musique en cours', 'Pause the current track'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    log.debug(`Commande pause par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) return;
    if (!(await ensureVoiceMembership(interaction, member))) return;

    const queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.noQueue')}`);
        return;
    }
    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) return;

    if (queue.isPaused) {
        await replyEphemeral(interaction, `⏸️ ${t(locale, 'pause.alreadyPaused')}`);
        return;
    }

    const success = queueManager.pause(interaction.guildId!);
    if (success) {
        log.info(`Pause: ${queue.currentTrack?.title}`);
        await replyEphemeral(interaction, `⏸️ ${t(locale, 'pause.success', { title: safeContent(queue.currentTrack?.title ?? '') })}`);
        return;
    }

    await replyEphemeral(interaction, `❌ ${t(locale, 'pause.failed')}`);
}
