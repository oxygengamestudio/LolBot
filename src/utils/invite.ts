import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

/** Permissions demandées à l'invitation : le strict nécessaire pour lire les commandes et jouer en vocal. */
const INVITE_PERMISSIONS =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.EmbedLinks |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.Connect |
    PermissionFlagsBits.Speak |
    PermissionFlagsBits.UseVAD |
    PermissionFlagsBits.UseApplicationCommands;

/** Lien pour ajouter le bot à un serveur. Il ne contient que l'identifiant public de l'application. */
export function getInviteLink(): string {
    const params = new URLSearchParams({
        client_id: config.discord.clientId,
        permissions: INVITE_PERMISSIONS.toString(),
        scope: 'bot applications.commands',
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
