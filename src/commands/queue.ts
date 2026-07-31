import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueViewManager } from '../services/QueueViewManager.js';
import { logger } from '../utils/Logger.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { replyEphemeral } from '../utils/commandHelpers.js';
import { canUseBot } from '../utils/permissions.js';

const log = logger.createModuleLogger('QueueCmd');

export const data = new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the music queue')
    .setDescriptionLocalizations(commandDescriptionLocalizations("Affiche la file d'attente des musiques", 'Show the music queue'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    if (!(await canUseBot(member))) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.noPermission')}`, false);
        return;
    }

    log.debug(`Commande queue par ${member.user.tag}`);
    await queueViewManager.show(interaction);
}
