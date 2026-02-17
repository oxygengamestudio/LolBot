import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { canUseBot } from './permissions.js';
import { config } from '../config.js';

export async function checkBasicPermissions(
    interaction: ChatInputCommandInteraction,
    member: GuildMember
): Promise<boolean> {
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: '❌ Vous n\'avez pas la permission d\'utiliser ce bot.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return false;
    }
    return true;
}

export function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): void {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignorer
        }
    }, config.audio.ephemeralInfoDeleteDelay);
}
