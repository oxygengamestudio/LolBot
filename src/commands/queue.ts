import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { queueViewManager } from '../services/QueueViewManager.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('QueueCmd');

export const data = new SlashCommandBuilder()
    .setName('queue')
    .setDescription("Affiche la file d'attente des musiques")
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
        });
        return;
    }

    log.debug(`Commande queue par ${(interaction.member as GuildMember).user.tag}`);
    await queueViewManager.show(interaction);
}
