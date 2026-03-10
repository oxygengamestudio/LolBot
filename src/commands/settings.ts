import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { buildSettingsMessage } from '../utils/settings-ui.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanManageSettings, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';

export const data = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure bot settings')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Configure les parametres du bot', 'Configure bot settings'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    if (!(await ensureCanManageSettings(interaction, member))) {
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);
    const message = buildSettingsMessage(settings);

    await interaction.reply({
        embeds: message.embeds,
        components: message.components,
        flags: 64,
        allowedMentions: { parse: [] },
    });
}
