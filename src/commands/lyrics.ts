import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { sendLyrics } from '../utils/lyrics.js';
import { config } from '../config.js';
import { t } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('LyricsCmd');

export const data = new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Affiche les paroles')
    .setDMPermission(false)
    .addStringOption(option =>
        option
            .setName('query')
            .setDescription('Titre ou artiste')
            .setRequired(false)
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
        });
        return;
    }

    log.debug(`Commande lyrics par ${interaction.user.tag}`);

    const locale = interaction.locale;
    const query = interaction.options.getString('query');
    const guildId = interaction.guildId;
    const queue = guildId ? queueManager.getQueue(guildId) : undefined;

    if (query && query.trim().length > 0) {
        await sendLyrics(interaction, query.trim(), queue);
        return;
    }

    if (!guildId) {
        await interaction.reply({
            content: t(locale, 'error.generic'),
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    if (!queue?.currentTrack) {
        await interaction.reply({
            content: t(locale, 'lyrics.noTrack'),
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    await sendLyrics(interaction, queue.currentTrack.title, queue);
}

async function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): Promise<void> {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignore
        }
    }, config.audio.ephemeralInfoDeleteDelay);
}
