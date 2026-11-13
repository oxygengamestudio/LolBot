import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { getInviteLink } from '../utils/invite.js';

export const data = new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Get the link to add the bot to another server')
    .setDescriptionLocalizations(commandDescriptionLocalizations(
        'Obtenir le lien pour ajouter le bot à un autre serveur',
        'Get the link to add the bot to another server'
    ))
    .setDMPermission(false);

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

    const link = getInviteLink();
    // Réponse visible uniquement par son auteur, et conservée pour qu'il puisse copier le lien.
    await interaction.reply({
        content: `🔗 ${t(locale, 'invite.message')}\n<${link}>`,
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel(t(locale, 'invite.button'))
            ),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
}
