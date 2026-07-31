import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { buildTrackLyricsQuery, sendLyrics } from '../utils/lyrics.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';
import { canUseBot } from '../utils/permissions.js';

const log = logger.createModuleLogger('LyricsCmd');

export const data = new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Affiche les paroles', 'Show lyrics'))
    .setDMPermission(false)
    .addStringOption((option) =>
        option
            .setName('query')
            .setDescription('Title or artist')
            .setDescriptionLocalizations(commandDescriptionLocalizations('Titre ou artiste', 'Title or artist'))
            .setRequired(false)
    );

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

    log.debug(`Commande lyrics par ${interaction.user.tag}`);

    const locale = await getInteractionLocale(interaction);
    const query = interaction.options.getString('query');
    const guildId = interaction.guildId;
    const queue = guildId ? queueManager.getQueue(guildId) : undefined;

    if (query?.trim()) {
        await sendLyrics(interaction, query.trim(), queue);
        return;
    }

    if (!guildId) {
        await replyEphemeral(interaction, t(locale, 'error.generic'));
        return;
    }

    if (!queue?.currentTrack) {
        await replyEphemeral(interaction, t(locale, 'lyrics.noTrack'));
        return;
    }

    await sendLyrics(interaction, buildTrackLyricsQuery(queue.currentTrack), queue);
}
