import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { nowPlayingManager } from '../services/NowPlayingManager.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { deleteEphemeralAfterDelay, ensureCanUseBot, ensureSameVoiceChannel, ensureVoiceMembership, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('StopCmd');

export const data = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Arrete la musique et vide la file d attente', 'Stop playback and clear the queue'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);

    log.debug(`Commande stop par ${member.user.tag}`);

    if (!(await ensureCanUseBot(interaction, member))) return;
    if (!(await ensureVoiceMembership(interaction, member))) return;

    const queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        await replyEphemeral(interaction, `❌ ${t(locale, 'error.noQueue')}`);
        return;
    }
    if (!(await ensureSameVoiceChannel(interaction, member, queue.voiceChannel.id))) return;

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);
    const shouldStay = settings.stayConnected || settings.stayConnectedAlways;

    if (shouldStay) {
        log.info('Arrêt de la lecture (bot reste connecté)');
        queueManager.stop(interaction.guildId!);
        await nowPlayingManager.deleteNowPlaying(queue);
        await interaction.editReply({ content: `⏹️ ${t(locale, 'stop.stay')}`, allowedMentions: { parse: [] } });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.info('Arrêt de la lecture et déconnexion');
    queueManager.deleteQueue(interaction.guildId!, true);
    await nowPlayingManager.deleteNowPlaying(queue);
    await interaction.editReply({ content: `⏹️ ${t(locale, 'stop.leave')}`, allowedMentions: { parse: [] } });
    deleteEphemeralAfterDelay(interaction);
}
