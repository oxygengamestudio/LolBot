import type {
    BaseInteraction,
    ButtonInteraction,
    ChatInputCommandInteraction,
    GuildMember,
    InteractionReplyOptions,
    ModalSubmitInteraction,
    RepliableInteraction,
    StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { canManageSettings, canUseBot } from './permissions.js';
import { resolveLocale, t } from './i18n.js';

type SupportedInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction;

export async function getInteractionLocale(interaction: BaseInteraction): Promise<'en' | 'fr'> {
    return resolveLocale(interaction.guildId, 'locale' in interaction ? interaction.locale : null);
}

export async function replyEphemeral(
    interaction: RepliableInteraction,
    content: string,
    autoDelete = true
): Promise<void> {
    const payload: InteractionReplyOptions = {
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    };

    if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
    } else {
        await interaction.reply(payload);
    }

    if (autoDelete) {
        scheduleDeleteReply(interaction);
    }
}

export function scheduleDeleteReply(interaction: RepliableInteraction, delayMs = config.audio.ephemeralInfoDeleteDelay): void {
    const safeDelayMs = Math.max(1, delayMs);
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignore.
        }
    }, safeDelayMs);
}

export const deleteEphemeralAfterDelay = scheduleDeleteReply;

export async function ensureCanUseBot(
    interaction: SupportedInteraction,
    member: GuildMember
): Promise<boolean> {
    if (await canUseBot(member)) {
        return true;
    }

    const locale = await getInteractionLocale(interaction);
    await replyEphemeral(interaction, `❌ ${t(locale, 'error.noPermission')}`);
    return false;
}

export async function ensureCanManageSettings(
    interaction: SupportedInteraction,
    member: GuildMember
): Promise<boolean> {
    if (await canManageSettings(member)) {
        return true;
    }

    const locale = await getInteractionLocale(interaction);
    await replyEphemeral(interaction, `❌ ${t(locale, 'error.manageSettings')}`, false);
    return false;
}

export async function ensureVoiceMembership(
    interaction: SupportedInteraction,
    member: GuildMember
): Promise<boolean> {
    if (member.voice.channel) {
        return true;
    }

    const locale = await getInteractionLocale(interaction);
    await replyEphemeral(interaction, `❌ ${t(locale, 'error.mustBeInVoice')}`);
    return false;
}

export async function ensureSameVoiceChannel(
    interaction: SupportedInteraction,
    member: GuildMember,
    botChannelId: string
): Promise<boolean> {
    if (member.voice.channelId === botChannelId) {
        return true;
    }

    const locale = await getInteractionLocale(interaction);
    await replyEphemeral(interaction, `❌ ${t(locale, 'error.sameVoice')}`);
    return false;
}

export async function checkBasicPermissions(
    interaction: ChatInputCommandInteraction,
    member: GuildMember
): Promise<boolean> {
    return ensureCanUseBot(interaction, member);
}
