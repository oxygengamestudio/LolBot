import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, StageChannel, VoiceChannel } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { canJoinVoiceChannel } from '../utils/permissions.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, getInteractionLocale, replyEphemeral, scheduleDeleteReply } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('JoinCmd');

export const data = new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the voice channel')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Rejoint le canal vocal', 'Join the voice channel'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);
    log.debug(`Commande join par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) {
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);
    let targetChannel: VoiceChannel | StageChannel | null = null;

    if (settings.preferredVoiceChannel) {
        const preferredChannel = member.guild.channels.cache.get(settings.preferredVoiceChannel);
        if (preferredChannel?.isVoiceBased()) {
            targetChannel = preferredChannel as VoiceChannel | StageChannel;
        } else {
            log.warn(`Preferred channel ${settings.preferredVoiceChannel} introuvable ou invalide`);
        }
    }

    if (!targetChannel) {
        if (!member.voice.channel) {
            await replyEphemeral(interaction, `❌ ${t(locale, 'join.requirePreferredOrVoice')}`);
            return;
        }
        targetChannel = member.voice.channel as VoiceChannel | StageChannel;
    }

    if (!(await canJoinVoiceChannel(targetChannel, interaction.guildId!))) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.voiceJoinDenied', { channel: `<#${targetChannel.id}>` })}`);
        return;
    }

    const existingQueue = queueManager.getQueue(interaction.guildId!);
    if (existingQueue?.connection && existingQueue.connection.state.status === 'ready') {
        await replyEphemeral(interaction, `✅ ${t(locale, 'join.alreadyConnected', { channel: `<#${existingQueue.voiceChannel.id}>` })}`);
        return;
    }

    const queue = queueManager.createQueue(
        interaction.guildId!,
        interaction.channel as any,
        targetChannel
    );

    try {
        const connection = await queueManager.joinChannel(queue);
        if (!connection) {
            await replyEphemeral(interaction, `❌ ${t(locale, 'error.voiceJoinFailed')}`);
            queueManager.deleteQueue(interaction.guildId!);
            return;
        }

        log.info(`Bot rejoint le canal: ${targetChannel.name}`);
        await interaction.reply({
            content: `✅ ${t(locale, 'join.connected', { channel: `<#${targetChannel.id}>` })}`,
            flags: 64,
            allowedMentions: { parse: [] },
        });
        scheduleDeleteReply(interaction);
    } catch (error) {
        log.error('Erreur lors de la connexion:', error);
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.voiceJoinFailed')}`);
        queueManager.deleteQueue(interaction.guildId!);
    }
}
