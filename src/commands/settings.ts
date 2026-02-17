import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, MessageFlags } from 'discord.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { canManageSettings } from '../utils/permissions.js';
import { buildSettingsMessage } from '../utils/settings-ui.js';

export const data = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure les paramètres du bot (Administrateurs uniquement)')
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.member as GuildMember;

    if (!(await canManageSettings(member))) {
        await interaction.reply({
            content: '❌ Vous devez être administrateur pour modifier les paramètres.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId!);
    const message = buildSettingsMessage(settings);

    await interaction.reply({
        embeds: message.embeds,
        components: message.components,
        flags: MessageFlags.Ephemeral,
    });
}
