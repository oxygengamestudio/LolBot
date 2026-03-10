import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, ensureSameVoiceChannel, ensureVoiceMembership, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('LeaveCmd');

export const data = new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect the bot from voice')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Deconnecte le bot du canal vocal', 'Disconnect the bot from voice'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    log.debug(`Commande leave par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) {
        return;
    }
    if (!(await ensureVoiceMembership(interaction, member))) {
        return;
    }

    const queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'leave.notConnected')}`);
        return;
    }

    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) {
        return;
    }

    log.info('Déconnexion via /leave');
    queueManager.deleteQueue(interaction.guildId!);
    await replyEphemeral(interaction, `👋 ${t(locale, 'leave.disconnected')}`);
}
