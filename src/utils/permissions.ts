import type { GuildMember, VoiceChannel, StageChannel } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from './Logger.js';

const log = logger.createModuleLogger('Permissions');

export async function canUseBot(member: GuildMember): Promise<boolean> {
    if (member.user.id === config.bot.ownerId) {
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
    const botMember = voiceChannel.guild.members.me;
    if (!botMember) {
        log.warn(`Bot member introuvable pour guild ${guildId}`);
        return false;
    }

    const botPerms = voiceChannel.permissionsFor(botMember);
    if (!botPerms) {
        log.warn(`Permissions introuvables pour le canal ${voiceChannel.id}`);
        return false;
    }

    const hasVoicePermissions = botPerms.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
    ]);
    if (!hasVoicePermissions) {
        log.debug(`Permissions vocales insuffisantes sur ${voiceChannel.id}`);
        return false;
    }

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
    if (member.user.id === config.bot.ownerId) {
        return true;
    }

    return member.permissions.has(PermissionFlagsBits.ManageGuild);
}
