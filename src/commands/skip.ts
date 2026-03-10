import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, ensureSameVoiceChannel, ensureVoiceMembership, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';
import { safeContent } from '../utils/text.js';

const log = logger.createModuleLogger('SkipCmd');

export const data = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Passe a la musique suivante', 'Skip the current track'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    log.debug(`Commande skip par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) return;
    if (!(await ensureVoiceMembership(interaction, member))) return;

    const queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.noQueue')}`);
        return;
    }
    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) return;

    const skippedTrack = safeContent(queue.currentTrack?.title ?? '');
    const nextTrack = queue.tracks[0] ? safeContent(queue.tracks[0].title) : null;

    log.info(`Skip: ${queue.currentTrack?.title}`);
    if (!queueManager.skip(interaction.guildId!)) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'skip.failed')}`);
        return;
    }

    let message = `⏭️ ${t(locale, 'skip.success', { title: skippedTrack })}`;
    message += nextTrack
        ? `\n▶️ ${t(locale, 'skip.next', { title: nextTrack })}`
        : `\n📋 ${t(locale, 'skip.empty')}`;
    await replyEphemeral(interaction, message);
}
