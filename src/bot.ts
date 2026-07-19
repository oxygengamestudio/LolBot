import {
    Client,
    GatewayIntentBits,
    ActivityType,
    Events,
    Collection,
    ButtonInteraction,
    ChannelSelectMenuInteraction,
    ChannelType,
    GuildMember,
    MessageFlags,
    ModalSubmitInteraction,
    RoleSelectMenuInteraction,
    StringSelectMenuInteraction,
    Status,
    Routes,
} from 'discord.js';
import dns from 'node:dns';
import { config } from './config.js';
import { commands } from './commands/index.js';
import { queueManager } from './services/QueueManager.js';
import { nowPlayingManager } from './services/NowPlayingManager.js';
import { queueViewManager } from './services/QueueViewManager.js';
import { guildSettingsManager } from './services/GuildSettingsManager.js';
import { handleLyricsDelete } from './utils/lyrics.js';
import { canJoinVoiceChannel, canManageSettings } from './utils/permissions.js';
import {
    buildSettingsMessage,
    buildLocalePrompt,
    buildSettingsModal,
    buildPreferredChannelPrompt,
    buildRolesPrompt,
    buildVoiceChannelsPrompt,
    buildRolesAddModal,
    getPagedRoles,
    parseSettingsModalId,
    parseRolesAddModalId,
    parseSettingsSelectId,
    SETTINGS_BUTTON_IDS,
    SETTINGS_SELECT_IDS,
} from './utils/settings-ui.js';
import { logger } from './utils/Logger.js';
import { runtimeReadiness } from './runtimeReadiness.js';
import { acquireProcessLock } from './utils/processLock.js';
import { getDiscordErrorCode, isKnownInteractionResponseError } from './utils/discordApiErrors.js';
import { loginDiscordWithRetry } from './utils/discordLogin.js';
import { resolveLocale, t } from './utils/i18n.js';
import { safeContent } from './utils/text.js';
import fs from 'fs';
import { join } from 'path';
import { handlePlaylistChoice, handleSelection as handlePlaySelection } from './commands/play.js';
import type { StageChannel, VoiceChannel } from 'discord.js';
import type { CommandDefinition, GuildSettings, RolePermissionMode, VoiceChannelMode } from './types/index.js';

const log = logger.createModuleLogger('Main');

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

function isSupportedNodeRuntime(version: string): boolean {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match) {
        return false;
    }

    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);

    return major > 22 || (major === 22 && minor >= 12);
}

type SettingsPromptInteraction =
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ChannelSelectMenuInteraction
    | RoleSelectMenuInteraction
    | ModalSubmitInteraction;

type SettingsPromptState = {
    timeout: NodeJS.Timeout;
    token: string;
    userKey: string;
};

const settingsPromptStates = new Map<string, SettingsPromptState>();
const settingsPromptByUser = new Map<string, string>();
let processLock: ReturnType<typeof acquireProcessLock> | null = null;

function isVoiceOrStageChannel(channel: unknown): channel is VoiceChannel | StageChannel {
    if (!channel || typeof channel !== 'object' || !('type' in channel)) {
        return false;
    }

    const channelType = (channel as { type: ChannelType }).type;
    return channelType === ChannelType.GuildVoice || channelType === ChannelType.GuildStageVoice;
}

function parsePermissionMode(mode: string): VoiceChannelMode | RolePermissionMode | null {
    if (mode === 'allow_all' || mode === 'whitelist' || mode === 'blacklist') {
        return mode;
    }
    return null;
}

function getSettingsUserKey(interaction: SettingsPromptInteraction): string {
    const guildId = interaction.guildId ?? 'dm';
    return `${guildId}:${interaction.user.id}`;
}

async function deleteSettingsPromptByToken(messageId: string, token: string): Promise<void> {
    try {
        if (!client.user) return;
        await client.rest.delete(Routes.webhookMessage(client.user.id, token, messageId));
    } catch (error) {
        const code = (error as { code?: number | string })?.code;
        if (code === 10008 || code === '10008') {
            return;
        }
        log.trace('Impossible de supprimer le prompt settings', error);
    }
}

function clearSettingsPromptState(messageId: string): void {
    const state = settingsPromptStates.get(messageId);
    if (!state) return;
    clearTimeout(state.timeout);
    settingsPromptStates.delete(messageId);
    const current = settingsPromptByUser.get(state.userKey);
    if (current === messageId) {
        settingsPromptByUser.delete(state.userKey);
    }
}

function refreshSettingsPrompt(
    interaction: SettingsPromptInteraction,
    messageId: string,
    token?: string,
    userKey?: string
): void {
    const existing = settingsPromptStates.get(messageId);
    if (existing) {
        clearTimeout(existing.timeout);
    }

    const finalToken = token ?? existing?.token ?? interaction.token;
    const finalUserKey = userKey ?? existing?.userKey ?? getSettingsUserKey(interaction);

    const timeout = setTimeout(async () => {
        clearSettingsPromptState(messageId);
        await deleteSettingsPromptByToken(messageId, finalToken);
    }, config.audio.ephemeralInteractiveDeleteDelay);

    settingsPromptStates.set(messageId, {
        timeout,
        token: finalToken,
        userKey: finalUserKey,
    });
}

function registerSettingsPrompt(interaction: SettingsPromptInteraction, messageId: string): void {
    const userKey = getSettingsUserKey(interaction);
    const existingMessageId = settingsPromptByUser.get(userKey);

    if (existingMessageId && existingMessageId !== messageId) {
        const existing = settingsPromptStates.get(existingMessageId);
        if (existing) {
            clearTimeout(existing.timeout);
            settingsPromptStates.delete(existingMessageId);
            void deleteSettingsPromptByToken(existingMessageId, existing.token);
        }
    }

    settingsPromptByUser.set(userKey, messageId);
    refreshSettingsPrompt(interaction, messageId, interaction.token, userKey);
}

// Créer les dossiers nécessaires
if (!fs.existsSync(config.paths.data)) {
    fs.mkdirSync(config.paths.data, { recursive: true });
    log.debug('Dossier data créé');
}
if (!fs.existsSync(config.paths.cache)) {
    fs.mkdirSync(config.paths.cache, { recursive: true });
    log.debug('Dossier cache créé');
}
if (!fs.existsSync(config.paths.guilds)) {
    fs.mkdirSync(config.paths.guilds, { recursive: true });
    log.debug('Dossier guild créé');
}

try {
    processLock = acquireProcessLock(join(config.paths.data, 'bot.lock'));
    log.debug(`Verrou process acquis: ${processLock.path}`);
    process.on('exit', () => {
        processLock?.release();
    });
} catch (error) {
    log.error('Impossible de démarrer une seconde instance du bot:', error);
    process.exit(1);
}

// Créer le client Discord avec tous les intents nécessaires
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});
let initialDiscordReadyObserved = false;
let discordRuntimeReady = false;
const markDiscordRuntimeUnavailable = (): void => {
    discordRuntimeReady = false;
    runtimeReadiness.notifyDiscordStateChanged();
};
const refreshDiscordRuntimeReady = (): void => {
    discordRuntimeReady = initialDiscordReadyObserved
        && client.ws.shards.size > 0
        && client.ws.shards.every((shard) => shard.status === Status.Ready);
    runtimeReadiness.notifyDiscordStateChanged();
};
runtimeReadiness.setDiscordReadyProbe(() => discordRuntimeReady);
client.on(Events.ShardDisconnect, markDiscordRuntimeUnavailable);
client.on(Events.ShardReconnecting, markDiscordRuntimeUnavailable);
client.on(Events.ShardReady, refreshDiscordRuntimeReady);
client.on(Events.ShardResume, refreshDiscordRuntimeReady);

log.info('Client Discord créé');
log.info(`Node runtime: ${process.version}`);
if (typeof dns.getDefaultResultOrder === 'function') {
    log.info(`DNS result order: ${dns.getDefaultResultOrder()}`);
}
if (!isSupportedNodeRuntime(process.version)) {
    const message = 'Node 22.12.0+ est requis pour @discordjs/voice 0.19.x et DAVE. Mettez a jour le runtime du bot.';
    if (config.nodeEnv === 'test') {
        log.warn(message);
    } else {
        log.error(message);
        process.exit(1);
    }
}

// Status amusants pour quand le bot n'écoute rien
const idleStatuses = [
    { name: '\u{1F3B5} En attente d\'une musique...', type: ActivityType.Custom },
    { name: '\u{1F3A7} Pr\u00eat \u00e0 jouer!', type: ActivityType.Custom },
    { name: '\u{1F3B6} /play pour d\u00e9marrer', type: ActivityType.Listening },
    { name: '\u{1F3A4} Le silence est d\'or...', type: ActivityType.Custom },
    { name: '\u{1F3B9} Mes touches sont pr\u00eates', type: ActivityType.Custom },
    { name: '\u{1F941} Tic tac, tic tac...', type: ActivityType.Custom },
    { name: '\u{1F3B8} Rock\'n\'roll?', type: ActivityType.Custom },
    { name: '\u{1F3BA} Tut tut tuuuut!', type: ActivityType.Custom },
];

let currentStatusIndex = 0;
let idleStatusInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

// Collection des commandes
const commandsMap = new Collection<string, CommandDefinition>();
for (const command of commands) {
    commandsMap.set(command.data.name, command);
    log.trace(`Commande chargée: /${command.data.name}`);
}
log.info(`${commandsMap.size} commandes chargées`);

// Générer le lien d'invitation
function getInviteLink(): string {
    // Permissions calculées:
    // - View Channels (1024)
    // - Send Messages (2048)
    // - Embed Links (16384)
    // - Connect (1048576)
    // - Speak (2097152)
    // - Use Voice Activity (33554432)
    // - Use Application Commands (2147483648)
    // Total: 2184271872
    const permissionsBitfield = '2184271872';

    return `https://discord.com/api/oauth2/authorize?client_id=${config.discord.clientId}&permissions=${permissionsBitfield}&scope=bot%20applications.commands`;
}

// Événement: Bot prêt
client.once(Events.ClientReady, async (readyClient) => {
    initialDiscordReadyObserved = true;
    refreshDiscordRuntimeReady();
    log.info(`Bot connecté en tant que ${readyClient.user.tag}`);
    log.info(`Présent sur ${readyClient.guilds.cache.size} serveur(s)`);

    log.info(`Lien d'invitation du bot: ${getInviteLink()}`);

    // Lister les serveurs
    log.debug('Serveurs connectés:');
    readyClient.guilds.cache.forEach((guild) => {
        log.debug(`  - ${guild.name} (${guild.id})`);
    });

    // Enregistrer les commandes au démarrage
    await registerCommands();

    // Définir le status initial
    updateIdleStatus();

    // Changer le status toutes les 30 secondes quand inactif
    if (idleStatusInterval) {
        clearInterval(idleStatusInterval);
    }

    idleStatusInterval = setInterval(() => {
        const activeQueues = queueManager.getAllQueues();
        if (activeQueues.size === 0) {
            updateIdleStatus();
        }
    }, 30_000);
});

// Événement: Interaction (commandes slash, boutons, autocomplete)
client.on(Events.InteractionCreate, async (interaction) => {
    log.trace(`Interaction reçue: ${interaction.type}`);

    try {
        // Autocomplete
        if (interaction.isAutocomplete()) {
            log.trace(`Autocomplete pour: ${interaction.commandName}`);
            const command = commandsMap.get(interaction.commandName);
            if (command?.autocomplete) {
                await command.autocomplete(interaction);
            }
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('play_select:')) {
            await handlePlaySelection(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('play_playlist:')) {
            await handlePlaylistChoice(interaction);
            return;
        }

        // Queue UI (boutons + select)
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('queue_')) {
                await queueViewManager.handleComponentInteraction(interaction);
                return;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('queue_move:')) {
                await queueViewManager.handleModalSubmit(interaction);
                return;
            }
            if (interaction.customId.startsWith('settings_modal:')) {
                await handleSettingsModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('settings_roles_add_modal:')) {
                await handleRolesAddModal(interaction);
                return;
            }
        }

        // Bouton suppression paroles
        if (interaction.isButton() && interaction.customId === 'lyrics_delete') {
            log.debug('Bouton cliqué: lyrics_delete');
            await handleLyricsDelete(interaction as ButtonInteraction);
            return;
        }

        // Boutons settings
        if (interaction.isButton() && interaction.customId.startsWith('settings_')) {
            log.debug('Bouton settings cliqué:', interaction.customId);
            await handleSettingsButton(interaction as ButtonInteraction);
            return;
        }

        // Select menus settings
        if (
            (interaction.isStringSelectMenu() ||
                interaction.isChannelSelectMenu() ||
                interaction.isRoleSelectMenu()) &&
            interaction.customId.startsWith('settings_')
        ) {
            await handleSettingsSelect(interaction);
            return;
        }

        // Boutons du Now Playing
        if (interaction.isButton()) {
            const buttonInteraction = interaction as ButtonInteraction;
            log.debug(`Bouton cliqué: ${buttonInteraction.customId}`);
            if (buttonInteraction.customId.startsWith('np_')) {
                await nowPlayingManager.handleButtonInteraction(buttonInteraction);
                return;
            }
        }

        // Commandes slash
        if (interaction.isChatInputCommand()) {
            log.info(`Commande: /${interaction.commandName} par ${interaction.user.tag}`);
            const command = commandsMap.get(interaction.commandName);
            if (!command) {
                log.error(`Commande non trouvée: ${interaction.commandName}`);
                return;
            }

            await command.execute(interaction);
        }
    } catch (error) {
        if (isKnownInteractionResponseError(error)) {
            const code = getDiscordErrorCode(error) ?? 'unknown';
            log.warn(
                `Interaction ignorée (code ${code}): déjà traitée ou expirée. Vérifie qu'une seule instance du bot est active.`
            );
            return;
        }

        log.error('Erreur lors du traitement de l\'interaction:', error);

        if (interaction.isAutocomplete()) {
            return;
        }

        // Essayer de répondre à l'interaction si possible
        if (interaction.isRepliable()) {
            const locale = await resolveLocale(interaction.guildId, 'locale' in interaction ? interaction.locale : null);
            const errorMessage = `❌ ${t(locale, 'error.generic')}`;
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({
                        content: errorMessage,
                        flags: MessageFlags.Ephemeral,
                        allowedMentions: { parse: [] },
                    });
                } else {
                    await interaction.reply({
                        content: errorMessage,
                        flags: MessageFlags.Ephemeral,
                        allowedMentions: { parse: [] },
                    });
                }
            } catch (e) {
                if (!isKnownInteractionResponseError(e)) {
                    log.trace('Impossible de répondre à l\'interaction');
                }
            }
        }
    }
});

// Debug: Écouter les événements voice state
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    log.trace('VoiceStateUpdate:', {
        userId: newState.member?.user.tag,
        oldChannel: oldState.channelId,
        newChannel: newState.channelId,
    });
    queueManager.handleVoiceStateChange(oldState, newState);
});

// Mettre à jour le status quand une musique joue
queueManager.on('trackStart', (queue) => {
    if (queue.currentTrack) {
        log.debug(`Status mis à jour: ${queue.currentTrack.title}`);
        client.user?.setActivity({
            name: queue.currentTrack.title,
            type: ActivityType.Listening,
        });
    }
});

queueManager.on('trackFailed', (queue, track, code) => {
    void (async () => {
        const locale = await resolveLocale(queue.guildId);
        await queue.textChannel.send({
            content: `❌ ${t(locale, 'play.videoLoadFailed')} — **${safeContent(track.title)}** (${code})`,
            allowedMentions: { parse: [] },
        });
    })().catch((error) => {
        log.warn('Impossible d\'annoncer l\'échec définitif de la piste', error);
    });
});

queueManager.on('queueEmpty', () => {
    log.debug('Queue vide, retour au status idle');
    updateIdleStatus();
});

queueManager.on('queueStopped', () => {
    log.debug('Queue arrêtée, retour au status idle');
    updateIdleStatus();
});

queueManager.on('queueDeleted', () => {
    // Vérifier s'il reste des queues actives
    const activeQueues = queueManager.getAllQueues();
    if (activeQueues.size === 0) {
        log.debug('Aucune queue active, retour au status idle');
        updateIdleStatus();
    }
});

// Fonction pour mettre à jour le status inactif
function updateIdleStatus(): void {
    const status = idleStatuses[currentStatusIndex];
    client.user?.setActivity({
        name: status.name,
        type: status.type,
    });
    currentStatusIndex = (currentStatusIndex + 1) % idleStatuses.length;
}

// Gestionnaire des boutons settings
async function handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) return;

    const member = interaction.member as GuildMember;
    if (!(await canManageSettings(member))) {
        const locale = await resolveLocale(interaction.guildId, interaction.locale);
        await interaction.reply({
            content: `❌ ${t(locale, 'error.manageSettings')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId);

    const prompt = parseSettingsSelectId(interaction.customId);
    if (prompt?.id === SETTINGS_SELECT_IDS.preferredClear) {
        const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
            preferredVoiceChannel: null,
        });
        await updateSettingsMessage(interaction, prompt.messageId, updated);
        await interaction.update({
            content: `✅ ${t(updated.locale, 'settings.updatedPreferred')}`,
            components: interaction.message.components,
            allowedMentions: { parse: [] },
        });
        if (interaction.message?.id) {
            refreshSettingsPrompt(interaction, interaction.message.id);
        }
        return;
    }
    if (prompt?.id === SETTINGS_SELECT_IDS.rolesPrev || prompt?.id === SETTINGS_SELECT_IDS.rolesNext) {
        const rolePage = prompt.page ?? 0;
        const nextPage = prompt.id === SETTINGS_SELECT_IDS.rolesPrev ? rolePage - 1 : rolePage + 1;
        const refreshed = buildRolesPrompt(settings, prompt.messageId, interaction.guild?.roles.cache, nextPage);
        await interaction.update({
            content: refreshed.content,
            components: refreshed.components,
        });
        if (interaction.message?.id) {
            refreshSettingsPrompt(interaction, interaction.message.id);
        }
        return;
    }
    if (prompt?.id === SETTINGS_SELECT_IDS.rolesClear) {
        const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
            allowedRoles: [],
            blockedRoles: [],
        });
        await updateSettingsMessage(interaction, prompt.messageId, updated);
        const refreshed = buildRolesPrompt(updated, prompt.messageId, interaction.guild?.roles.cache, prompt.page ?? 0);
        await interaction.update({
            content: `✅ ${t(updated.locale, 'settings.updatedRolesCleared')}\n${refreshed.content}`,
            components: refreshed.components,
            allowedMentions: { parse: [] },
        });
        if (interaction.message?.id) {
            refreshSettingsPrompt(interaction, interaction.message.id);
        }
        return;
    }
    if (prompt?.id === SETTINGS_SELECT_IDS.rolesAdd) {
        if (interaction.message?.id) {
            await interaction.showModal(buildRolesAddModal(interaction.message.id, settings.locale));
            refreshSettingsPrompt(interaction, interaction.message.id);
        }
        return;
    }

    switch (interaction.customId) {
        case SETTINGS_BUTTON_IDS.volume: {
            if (interaction.message?.id) {
                await interaction.showModal(buildSettingsModal('volume', settings, interaction.message.id));
            }
            return;
        }
        case SETTINGS_BUTTON_IDS.preferred: {
            if (interaction.message?.id) {
                const promptMessage = buildPreferredChannelPrompt(settings, interaction.message.id);
                await interaction.reply({ ...promptMessage, flags: MessageFlags.Ephemeral });
                const promptReply = await interaction.fetchReply().catch(() => null);
                const promptId = promptReply?.id ?? interaction.id;
                registerSettingsPrompt(interaction, promptId);
            }
            return;
        }
        case SETTINGS_BUTTON_IDS.voice: {
            if (interaction.message?.id) {
                const promptMessage = buildVoiceChannelsPrompt(settings, interaction.message.id);
                await interaction.reply({ ...promptMessage, flags: MessageFlags.Ephemeral });
                const promptReply = await interaction.fetchReply().catch(() => null);
                const promptId = promptReply?.id ?? interaction.id;
                registerSettingsPrompt(interaction, promptId);
            }
            return;
        }
        case SETTINGS_BUTTON_IDS.roles: {
            if (interaction.message?.id) {
                const promptMessage = buildRolesPrompt(settings, interaction.message.id, interaction.guild?.roles.cache);
                await interaction.reply({ ...promptMessage, flags: MessageFlags.Ephemeral });
                const promptReply = await interaction.fetchReply().catch(() => null);
                const promptId = promptReply?.id ?? interaction.id;
                registerSettingsPrompt(interaction, promptId);
            }
            return;
        }
        case SETTINGS_BUTTON_IDS.locale: {
            if (interaction.message?.id) {
                const promptMessage = buildLocalePrompt(settings, interaction.message.id);
                await interaction.reply({
                    ...promptMessage,
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                const promptReply = await interaction.fetchReply().catch(() => null);
                const promptId = promptReply?.id ?? interaction.id;
                registerSettingsPrompt(interaction, promptId);
            }
            return;
        }
        case SETTINGS_BUTTON_IDS.stay: {
            const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                stayConnected: !settings.stayConnected,
            });
            await interaction.update(buildSettingsMessage(updated));
            return;
        }
        case SETTINGS_BUTTON_IDS.always: {
            const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                stayConnectedAlways: !settings.stayConnectedAlways,
            });
            await interaction.update(buildSettingsMessage(updated));
            return;
        }
        case SETTINGS_BUTTON_IDS.pauseOnEmpty: {
            const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                pauseOnEmptyChannelWhenAlwaysConnected: !settings.pauseOnEmptyChannelWhenAlwaysConnected,
            });
            await interaction.update(buildSettingsMessage(updated));
            return;
        }
        case SETTINGS_BUTTON_IDS.sponsor: {
            const updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                sponsorBlockEnabled: !settings.sponsorBlockEnabled,
            });
            await interaction.update(buildSettingsMessage(updated));
            return;
        }
        default:
            return;
    }
}

async function handleSettingsModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) return;

    const member = interaction.member as GuildMember;
    if (!(await canManageSettings(member))) {
        const locale = await resolveLocale(interaction.guildId, interaction.locale);
        await interaction.reply({
            content: `❌ ${t(locale, 'error.manageSettings')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const locale = await resolveLocale(interaction.guildId, interaction.locale);

    const parsed = parseSettingsModalId(interaction.customId);
    if (!parsed || parsed.kind !== 'volume') return;

    const raw = interaction.fields.getTextInputValue('value').trim();
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0 || value > 200) {
        await interaction.reply({
            content: `❌ ${t(locale, 'error.invalidVolume')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const updated = await guildSettingsManager.updateSettings(interaction.guildId, { volume: value });
    queueManager.setVolume(interaction.guildId, value);
    await updateSettingsMessage(interaction, parsed.messageId, updated);
    await interaction.reply({
        content: `✅ ${t(updated.locale, 'common.updated')}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
}

async function handleSettingsSelect(
    interaction: StringSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction
): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) return;

    const member = interaction.member as GuildMember;
    if (!(await canManageSettings(member))) {
        const locale = await resolveLocale(interaction.guildId, interaction.locale);
        await interaction.reply({
            content: `❌ ${t(locale, 'error.manageSettings')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const parsed = parseSettingsSelectId(interaction.customId);
    if (!parsed) return;

    const settings = await guildSettingsManager.getSettings(interaction.guildId);
    let updated: GuildSettings | null = null;
    let preferredMoveError: string | null = null;

    switch (parsed.id) {
        case SETTINGS_SELECT_IDS.localeSelect: {
            if (!interaction.isStringSelectMenu()) return;
            const selectedLocale = interaction.values[0];
            if (selectedLocale !== 'fr' && selectedLocale !== 'en') {
                return;
            }
            updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                locale: selectedLocale,
            });
            break;
        }
        case SETTINGS_SELECT_IDS.preferredSelect: {
            if (!interaction.isChannelSelectMenu()) return;
            const channelId = interaction.values[0];
            updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                preferredVoiceChannel: channelId ?? null,
            });
            const queue = queueManager.getQueue(interaction.guildId);
            const guild = interaction.guild;
            if (queue && queue.connection && guild) {
                const preferredChannel = guild.channels.cache.get(channelId);
                if (isVoiceOrStageChannel(preferredChannel)) {
                    if (queue.voiceChannel.id !== preferredChannel.id) {
                        if (await canJoinVoiceChannel(preferredChannel, interaction.guildId)) {
                            const moved = await queueManager.moveToChannel(queue, preferredChannel);
                            if (!moved) {
                                preferredMoveError = `❌ ${t(settings.locale, 'settings.preferredMoveFailed')}`;
                            }
                        } else {
                            preferredMoveError = `❌ ${t(settings.locale, 'error.voiceJoinDenied', { channel: `<#${preferredChannel.id}>` })}`;
                        }
                    }
                } else {
                    preferredMoveError = `❌ ${t(settings.locale, 'settings.preferredInvalid')}`;
                }
            }
            break;
        }
        case SETTINGS_SELECT_IDS.voiceMode: {
            if (!interaction.isStringSelectMenu()) return;
            const mode = parsePermissionMode(interaction.values[0]);
            if (!mode) return;
            const updates: Partial<GuildSettings> = { voiceChannelMode: mode as VoiceChannelMode };
            if (mode === 'allow_all') {
                updates.allowedVoiceChannels = [];
                updates.blockedVoiceChannels = [];
            }
            updated = await guildSettingsManager.updateSettings(interaction.guildId, updates);
            break;
        }
        case SETTINGS_SELECT_IDS.voiceList: {
            if (!interaction.isChannelSelectMenu()) return;
            const list = interaction.values;
            if (settings.voiceChannelMode === 'whitelist') {
                updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                    allowedVoiceChannels: list,
                });
            } else if (settings.voiceChannelMode === 'blacklist') {
                updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                    blockedVoiceChannels: list,
                });
            } else {
                if (list.length > 0) {
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                        voiceChannelMode: 'whitelist',
                        allowedVoiceChannels: list,
                        blockedVoiceChannels: [],
                    });
                } else {
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                        allowedVoiceChannels: [],
                        blockedVoiceChannels: [],
                    });
                }
            }
            break;
        }
        case SETTINGS_SELECT_IDS.rolesMode: {
            if (!interaction.isStringSelectMenu()) return;
            const mode = parsePermissionMode(interaction.values[0]);
            if (!mode) return;
            const updates: Partial<GuildSettings> = { rolePermissionMode: mode as RolePermissionMode };
            if (mode === 'allow_all') {
                updates.allowedRoles = [];
                updates.blockedRoles = [];
            }
            updated = await guildSettingsManager.updateSettings(interaction.guildId, updates);
            break;
        }
        case SETTINGS_SELECT_IDS.rolesList: {
            const list = interaction.values;
            const page = parsed.page ?? 0;

            if (interaction.isStringSelectMenu() && interaction.guild) {
                const roleCache = interaction.guild.roles.cache;
                const { pageRoles } = getPagedRoles(roleCache, page);
                const pageIds = pageRoles.map((role) => role.id);

                if (settings.rolePermissionMode === 'blacklist') {
                    const base = (settings.blockedRoles ?? []).filter((id) => !pageIds.includes(id));
                    const merged = Array.from(new Set([...base, ...list]));
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                        blockedRoles: merged,
                    });
                } else {
                    const base = (settings.allowedRoles ?? []).filter((id) => !pageIds.includes(id));
                    const merged = Array.from(new Set([...base, ...list]));
                    const updates: Partial<GuildSettings> = { allowedRoles: merged };
                    if (settings.rolePermissionMode === 'allow_all' && merged.length > 0) {
                        updates.rolePermissionMode = 'whitelist';
                    }
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, updates);
                }
            } else {
                if (!interaction.isRoleSelectMenu()) return;
                if (settings.rolePermissionMode === 'whitelist') {
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                        allowedRoles: list,
                    });
                } else if (settings.rolePermissionMode === 'blacklist') {
                    updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                        blockedRoles: list,
                    });
                } else {
                    if (list.length > 0) {
                        updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                            rolePermissionMode: 'whitelist',
                            allowedRoles: list,
                            blockedRoles: [],
                        });
                    } else {
                        updated = await guildSettingsManager.updateSettings(interaction.guildId, {
                            allowedRoles: [],
                            blockedRoles: [],
                        });
                    }
                }
            }
            break;
        }
        default:
            break;
    }

    if (!updated) {
        await interaction.deferUpdate();
        return;
    }

    await updateSettingsMessage(interaction, parsed.messageId, updated);

    let prompt;
    if (parsed.id === SETTINGS_SELECT_IDS.localeSelect) {
        prompt = buildLocalePrompt(updated, parsed.messageId);
    } else if (parsed.id === SETTINGS_SELECT_IDS.preferredSelect || parsed.id === SETTINGS_SELECT_IDS.preferredClear) {
        prompt = buildPreferredChannelPrompt(updated, parsed.messageId);
    } else if (parsed.id === SETTINGS_SELECT_IDS.voiceMode || parsed.id === SETTINGS_SELECT_IDS.voiceList) {
        prompt = buildVoiceChannelsPrompt(updated, parsed.messageId);
    } else {
        prompt = buildRolesPrompt(updated, parsed.messageId, interaction.guild?.roles.cache, parsed.page ?? 0);
    }

    await interaction.update({
        content: `✅ ${t(updated.locale, 'common.updated')}\n${prompt.content}`,
        components: prompt.components,
        allowedMentions: { parse: [] },
    });
    if (preferredMoveError) {
        await interaction.followUp({
            content: preferredMoveError,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    }
    if (interaction.message?.id) {
        refreshSettingsPrompt(interaction, interaction.message.id);
    }
}


async function handleRolesAddModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) return;

    const member = interaction.member as GuildMember;
    if (!(await canManageSettings(member))) {
        const locale = await resolveLocale(interaction.guildId, interaction.locale);
        await interaction.reply({
            content: `❌ ${t(locale, 'error.manageSettings')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const messageId = parseRolesAddModalId(interaction.customId);
    if (!messageId) return;
    const locale = await resolveLocale(interaction.guildId, interaction.locale);

    const raw = interaction.fields.getTextInputValue('roles');
    const tokens = raw
        .split(/[\r\n,]/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

    const roleIds = new Set<string>();
    const guildRoles = interaction.guild?.roles.cache;
    if (!guildRoles) {
        await interaction.reply({
            content: `❌ ${t(locale, 'settings.roleReadFailed')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    for (const token of tokens) {
        const ids = token.match(/\d{17,20}/g) ?? [];
        if (ids.length > 0) {
            ids.forEach((id) => roleIds.add(id));
            continue;
        }

        const matches = guildRoles.filter((role) => role.name.toLowerCase() === token.toLowerCase());
        if (matches.size === 1) {
            roleIds.add(matches.first()!.id);
            continue;
        }

        if (matches.size > 1) {
            await interaction.reply({
                content: `❌ ${t(locale, 'settings.roleAmbiguous', { value: token })}`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return;
        }

        const partial = guildRoles.filter((role) => role.name.toLowerCase().includes(token.toLowerCase()));
        if (partial.size === 1) {
            roleIds.add(partial.first()!.id);
            continue;
        }

        await interaction.reply({
            content: `❌ ${t(locale, 'settings.roleNotFound', { value: token })}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    if (roleIds.size === 0) {
        await interaction.reply({
            content: `❌ ${t(locale, 'settings.noValidRole')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const settings = await guildSettingsManager.getSettings(interaction.guildId);
    const list = Array.from(roleIds);

    let updated: GuildSettings;
    if (settings.rolePermissionMode === 'blacklist') {
        const merged = Array.from(new Set([...(settings.blockedRoles ?? []), ...list]));
        updated = await guildSettingsManager.updateSettings(interaction.guildId, { blockedRoles: merged });
    } else {
        const merged = Array.from(new Set([...(settings.allowedRoles ?? []), ...list]));
        updated = await guildSettingsManager.updateSettings(interaction.guildId, {
            rolePermissionMode: settings.rolePermissionMode === 'allow_all' ? 'whitelist' : settings.rolePermissionMode,
            allowedRoles: merged,
        });
    }

    await updateSettingsMessage(interaction, messageId, updated);
    const prompt = buildRolesPrompt(updated, messageId, interaction.guild?.roles.cache);
    await interaction.reply({
        content: `✅ ${t(updated.locale, 'settings.rolesAdded')}\n${prompt.content}`,
        components: prompt.components,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
    const promptReply = await interaction.fetchReply().catch(() => null);
    const promptId = promptReply?.id ?? interaction.id;
    registerSettingsPrompt(interaction, promptId);
}

async function updateSettingsMessage(
    interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction,
    messageId: string,
    settings: GuildSettings
): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;
    try {
        const message = await channel.messages.fetch(messageId);
        await message.edit(buildSettingsMessage(settings));
    } catch (error) {
        const code = (error as { code?: number | string })?.code;
        if (code === 10008 || code === '10008') {
            return;
        }
        log.trace('Impossible de mettre à jour le message settings', error);
    }
}

// Fonction pour enregistrer les commandes
async function registerCommands(): Promise<void> {
    try {
        const { REST, Routes } = await import('discord.js');
        const rest = new REST({ version: '10' }).setToken(config.discord.token);

        log.info('Actualisation des commandes slash...');

        const commandsData = commands.map(cmd => cmd.data.toJSON());
        const configuredScope = config.discord.commandScope;
        const effectiveScope = configuredScope === 'auto'
            ? (config.discord.guildId ? 'guild' : 'global')
            : configuredScope;

        if (effectiveScope === 'guild') {
            if (!config.discord.guildId) {
                throw new Error(
                    'DISCORD_COMMAND_SCOPE=guild requires DISCORD_GUILD_ID.'
                );
            }

            log.debug(
                `Enregistrement guild (${config.discord.guildId}) (configured: ${configuredScope}, effective: guild)...`
            );
            await rest.put(
                Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
                { body: commandsData }
            );

            log.debug('Nettoyage des commandes globales (évite les doublons)...');
            await rest.put(
                Routes.applicationCommands(config.discord.clientId),
                { body: [] }
            );

            log.info(
                `${commandsData.length} commande(s) actualisée(s) (configured: ${configuredScope}, effective: guild)`
            );
            return;
        }

        log.debug(
            `Enregistrement global (configured: ${configuredScope}, effective: global)...`
        );
        await rest.put(
            Routes.applicationCommands(config.discord.clientId),
            { body: commandsData }
        );

        if (config.discord.guildId) {
            log.debug(
                `Nettoyage des commandes guild (${config.discord.guildId}) pour éviter les doublons...`
            );
            await rest.put(
                Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
                { body: [] }
            );
        }

        log.info(
            `${commandsData.length} commande(s) actualisée(s) (configured: ${configuredScope}, effective: global)`
        );
    } catch (error) {
        log.error('Erreur lors de l\'actualisation des commandes:', error);
    }
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (error) => {
    log.error('Unhandled promise rejection:', error);
    void gracefulShutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
    log.error('Uncaught exception:', error);
    void gracefulShutdown('uncaughtException', 1);
});

// Gestion de l'arrêt propre
async function gracefulShutdown(reason: NodeJS.Signals | 'unhandledRejection' | 'uncaughtException' | 'loginFailed', exitCode = 0): Promise<void> {
    if (isShuttingDown) {
        log.warn(`${reason} reçu pendant l'arrêt, arrêt déjà en cours.`);
        return;
    }

    isShuttingDown = true;
    log.info(`${reason} reçu, arrêt du bot...`);
    const forceExit = setTimeout(() => {
        log.error('Délai maximal d’arrêt dépassé, fermeture forcée.');
        process.exit(exitCode || 1);
    }, 10_000);
    forceExit.unref();

    if (idleStatusInterval) {
        clearInterval(idleStatusInterval);
        idleStatusInterval = null;
    }

    for (const state of settingsPromptStates.values()) {
        clearTimeout(state.timeout);
    }
    settingsPromptStates.clear();
    settingsPromptByUser.clear();

    const guildIds = Array.from(queueManager.getAllQueues().keys());
    for (const guildId of guildIds) {
        queueManager.deleteQueue(guildId, true);
    }

    await guildSettingsManager.flushAll().catch((error) => {
        log.error('Impossible de vider les réglages avant arrêt:', error);
        exitCode = exitCode || 1;
    });

    try {
        processLock?.release();
        processLock = null;
        client.destroy();
    } catch (error) {
        log.error('Erreur lors de la fermeture du client Discord:', error);
    }

    clearTimeout(forceExit);
    process.exit(exitCode);
}

process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
});

log.info('Dependances requises: FFmpeg (https://ffmpeg.org/) et yt-dlp (https://github.com/yt-dlp/yt-dlp)');

// Connexion du bot
log.info('Démarrage du bot...');
void loginDiscordWithRetry(
    () => client.login(config.discord.token),
    {
        onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, code }) => {
            log.warn(
                `Connexion Discord temporairement indisponible (${code ?? 'erreur réseau'}, tentative ${attempt}/${maxAttempts}); `
                + `nouvel essai ${nextAttempt}/${maxAttempts} dans ${delayMs}ms.`
            );
        },
    }
).catch((error) => {
    log.error('Connexion Discord impossible:', error);
    void gracefulShutdown('loginFailed', 1);
});
