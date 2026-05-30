import {
    SlashCommandBuilder,
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags,
    StageChannel,
    StringSelectMenuInteraction,
    TextChannel,
    VoiceChannel,
} from 'discord.js';
import { youtubeService } from '../services/YouTubeService.js';
import { queueManager } from '../services/QueueManager.js';
import { canUseBot, canJoinVoiceChannel } from '../utils/permissions.js';
import { guildSettingsManager } from '../services/GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import { isKnownInteractionResponseError } from '../utils/discordApiErrors.js';
import type { SearchResult, Track } from '../types/index.js';
import { commandDescriptionLocalizations, resolveLocale, t } from '../utils/i18n.js';
import { safeContent, truncate } from '../utils/text.js';

const log = logger.createModuleLogger('PlayCmd');
const AUTOCOMPLETE_DEBOUNCE_MS = 1_500;
const AUTOCOMPLETE_HINT_PREFIX = '__hint_';
const AUTOCOMPLETE_HINT_START_TYPING = '__hint_start_typing__';
const AUTOCOMPLETE_HINT_REFINE = '__hint_refine_query__';
const AUTOCOMPLETE_HINT_NO_RESULTS = '__hint_no_results__';
const MAX_AUTOCOMPLETE_OPTIONS = 25;
const PLAY_SELECTION_PREFIX = 'play_select';

type AutocompleteOption = { name: string; value: string };
type PlayInteraction = ChatInputCommandInteraction | StringSelectMenuInteraction;
type AutocompleteState = {
    lastApiCallAt: number;
    lastQuery: string;
    lastOptions: AutocompleteOption[];
};
type PendingPlaySelection = {
    createdAt: number;
    guildId: string;
    userId: string;
    textChannelId: string;
    voiceChannelId: string;
    requestedBy: string;
    requestedById: string;
    query: string;
    results: SearchResult[];
};

const autocompleteState = new Map<string, AutocompleteState>();
const pendingSelections = new Map<string, PendingPlaySelection>();

export const data = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track from YouTube')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Joue une musique depuis YouTube', 'Play a track from YouTube'))
    .setDMPermission(false)
    .addStringOption(option =>
        option
            .setName('query')
            .setDescription('YouTube URL or search terms')
            .setDescriptionLocalizations(commandDescriptionLocalizations('URL YouTube ou termes de recherche', 'YouTube URL or search terms'))
            .setRequired(true)
            .setAutocomplete(true)
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: `❌ ${t(interaction.locale, 'error.guildOnly')}`,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;
    const locale = await resolveLocale(interaction.guildId, interaction.locale);

    log.debug(`Commande play par ${member.user.tag}`);

    // Vérification permissions
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: `❌ ${t(locale, 'error.noPermission')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    if (!voiceChannel) {
        await interaction.reply({
            content: `❌ ${t(locale, 'error.mustBeInVoice')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
        await interaction.reply({
            content: `❌ ${t(locale, 'error.generic')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const query = interaction.options.getString('query', true);
    if (isAutocompleteHintValue(query)) {
        await interaction.reply({
            content: `ℹ️ ${t(locale, 'error.interactionHint')}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const textChannel = interaction.channel as TextChannel;

    const settings = await guildSettingsManager.getSettings(guildId);
    let targetChannel: VoiceChannel | StageChannel = voiceChannel;

    if (settings.preferredVoiceChannel) {
        const preferredChannel = member.guild.channels.cache.get(settings.preferredVoiceChannel);
        if (preferredChannel && preferredChannel.isVoiceBased()) {
            targetChannel = preferredChannel as VoiceChannel | StageChannel;
        } else {
            log.warn(`Preferred channel ${settings.preferredVoiceChannel} introuvable ou invalide`);
        }
    }

    if (!(await canJoinVoiceChannel(targetChannel, guildId))) {
        await interaction.reply({
            content: `❌ ${t(locale, 'error.voiceJoinDenied', { channel: `<#${targetChannel.id}>` })}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.info(`Query: ${query}`);

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        if (isKnownInteractionResponseError(error)) {
            log.warn('Interaction /play déjà traitée ou expirée, abandon.');
            return;
        }
        throw error;
    }

    try {
        if (youtubeService.isYouTubeUrl(query)) {
            log.debug('Detecte comme URL YouTube');
            await handleYouTubeUrl(interaction, query, member, targetChannel, textChannel, locale);
        } else {
            log.debug('Detecte comme recherche (auto)');
            await handleSearchAuto(interaction, query, member, targetChannel, textChannel, locale);
        }
    } catch (error) {
        log.error('Erreur:', error);
        await interaction.editReply({
            content: t(locale, 'error.generic'),
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
    }
}

export async function handleSelection(interaction: StringSelectMenuInteraction): Promise<void> {
    const selectionId = parseSelectionId(interaction.customId);
    const payload = selectionId ? pendingSelections.get(selectionId) : null;
    if (!selectionId || !payload) {
        await interaction.update({
            content: 'Cette sélection a expiré. Relance `/play`.',
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    if (interaction.user.id !== payload.userId || interaction.guildId !== payload.guildId) {
        await interaction.reply({
            content: 'Cette sélection ne vous appartient pas.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    const index = Number.parseInt(interaction.values?.[0] ?? '', 10);
    if (!Number.isInteger(index) || index < 0 || index >= payload.results.length) {
        await interaction.update({
            content: 'Sélection invalide.',
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    const guild = interaction.guild;
    const member = interaction.member as GuildMember;
    const textChannel = guild?.channels.cache.get(payload.textChannelId) as TextChannel | undefined;
    const voiceChannel = guild?.channels.cache.get(payload.voiceChannelId);
    if (!guild || !textChannel || !voiceChannel?.isVoiceBased()) {
        pendingSelections.delete(selectionId);
        await interaction.update({
            content: 'Salon introuvable. Relance `/play`.',
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    if (!(await canJoinVoiceChannel(voiceChannel, guild.id))) {
        await interaction.update({
            content: `Je n'ai pas l'autorisation de rejoindre <#${voiceChannel.id}>.`,
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    const result = payload.results[index];
    const track = await youtubeService.createTrackFromSearch(result, payload.requestedBy, payload.requestedById);
    pendingSelections.delete(selectionId);

    await interaction.update({
        content: `Ajout de **${safeContent(track.title)}**...`,
        components: [],
        allowedMentions: { parse: [] },
    });

    const locale = await resolveLocale(guild.id, interaction.locale);
    await addTrackToQueue(interaction, track, voiceChannel as VoiceChannel | StageChannel, textChannel, locale);
}

function parseSelectionId(customId: string): string | null {
    if (!customId.startsWith(`${PLAY_SELECTION_PREFIX}:`)) {
        return null;
    }
    return customId.split(':', 2)[1] ?? null;
}

async function handleYouTubeUrl(
    interaction: ChatInputCommandInteraction,
    url: string,
    member: GuildMember,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel,
    locale: 'en' | 'fr'
): Promise<void> {
    if (youtubeService.isPlaylistUrl(url)) {
        log.debug('URL de playlist detectee');
        const playlistId = youtubeService.extractPlaylistId(url);
        if (!playlistId) {
            log.warn('ID de playlist invalide');
            await interaction.editReply({
                content: t(locale, 'play.playlistInvalid'),
                allowedMentions: { parse: [] },
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }

        await interaction.editReply({
            content: t(locale, 'play.playlistLoading'),
            allowedMentions: { parse: [] },
        });

        log.debug(`Chargement playlist: ${playlistId}`);
        const playlist = await youtubeService.getPlaylistTracks(
            playlistId,
            member.displayName,
            member.id
        );

        if (!playlist || playlist.tracks.length === 0) {
            log.warn('Playlist introuvable ou vide');
            await interaction.editReply({
                content: t(locale, 'play.playlistEmpty'),
                allowedMentions: { parse: [] },
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }

        log.info(`Playlist chargee: ${playlist.title} (${playlist.tracks.length} pistes)`);

        const tracks = playlist.tracks.slice(0, config.audio.maxPlaylistTracks);

        let queue = queueManager.getQueue(interaction.guildId!);
        if (!queue) {
            queue = queueManager.createQueue(interaction.guildId!, textChannel, voiceChannel);
        } else if (queue.voiceChannel.id !== voiceChannel.id) {
            if (!(await canJoinVoiceChannel(voiceChannel, interaction.guildId!))) {
                await interaction.editReply({
                    content: `❌ ${t(locale, 'error.voiceJoinDenied', { channel: `<#${voiceChannel.id}>` })}`,
                    allowedMentions: { parse: [] },
                });
                deleteEphemeralAfterDelay(interaction);
                return;
            }
            const moved = await queueManager.moveToChannel(queue, voiceChannel);
            if (!moved) {
                await interaction.editReply({
                    content: `❌ ${t(locale, 'settings.preferredMoveFailed')}`,
                    allowedMentions: { parse: [] },
                });
                deleteEphemeralAfterDelay(interaction);
                return;
            }
        }

        const wasEmpty = queue.tracks.length === 0 && !queue.currentTrack;
        const addedCount = queueManager.addTracks(interaction.guildId!, tracks);

        if (addedCount <= 0) {
            await interaction.editReply({
                content: t(locale, 'play.queueFull'),
                allowedMentions: { parse: [] },
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }

        if (wasEmpty && addedCount > 0) {
            log.debug('Queue etait vide, demarrage de la lecture');
            const playNextStart = Date.now();
            await queueManager.playNext(interaction.guildId!);
            log.debug(`request_to_playNext_ms=${Date.now() - playNextStart} (playlist)`);
        }

        await interaction.editReply({
            content: t(locale, 'play.playlistAdded', {
                title: safeContent(playlist.title),
                count: addedCount,
            }),
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.debug('URL de video simple');
    const track = await youtubeService.createTrackFromUrl(
        url,
        member.displayName,
        member.id
    );

    if (!track) {
        log.error('Impossible de charger la video');
        await interaction.editReply({
            content: t(locale, 'play.videoLoadFailed'),
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.info(`Track cree: ${track.title}`);
    await addTrackToQueue(interaction, track, voiceChannel, textChannel, locale);
}

async function handleSearchAuto(
    interaction: ChatInputCommandInteraction,
    query: string,
    member: GuildMember,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel,
    locale: 'en' | 'fr'
): Promise<void> {
    await interaction.editReply({
        content: t(locale, 'play.searching', { query: safeContent(query) }),
        allowedMentions: { parse: [] },
    });

    log.debug(`Recherche YouTube (auto): ${query}`);
    const rankedResults = await youtubeService.searchWithRanking(query, config.audio.searchResults);
    const results = rankedResults.map((result) => {
        const { score: _score, ...searchResult } = result;
        return searchResult;
    });

    if (results.length === 0) {
        log.debug('Aucun resultat (auto)');
        await interaction.editReply({
            content: t(locale, 'play.noResults'),
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const selectedResult = rankedResults[0];
    log.info(`Auto-selectionne: ${selectedResult.title}`);

    const track = await youtubeService.createTrackFromSearch(
        selectedResult,
        member.displayName,
        member.id
    );

    await addTrackToQueue(interaction, track, voiceChannel, textChannel, locale);
}

async function addTrackToQueue(
    interaction: PlayInteraction,
    track: Track,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel,
    locale: 'en' | 'fr'
): Promise<void> {
    let queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        log.debug('Creation d\'une nouvelle queue');
        queue = queueManager.createQueue(interaction.guildId!, textChannel, voiceChannel);
    } else if (queue.voiceChannel.id !== voiceChannel.id) {
        if (!(await canJoinVoiceChannel(voiceChannel, interaction.guildId!))) {
            await interaction.editReply({
                content: `❌ ${t(locale, 'error.voiceJoinDenied', { channel: `<#${voiceChannel.id}>` })}`,
                allowedMentions: { parse: [] },
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }
        const moved = await queueManager.moveToChannel(queue, voiceChannel);
        if (!moved) {
            await interaction.editReply({
                content: `❌ ${t(locale, 'settings.preferredMoveFailed')}`,
                allowedMentions: { parse: [] },
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }
    }

    const wasEmpty = queue.tracks.length === 0 && !queue.currentTrack;
    const added = queueManager.addTrack(interaction.guildId!, track);
    if (added <= 0) {
        await interaction.editReply({
            content: t(locale, 'play.queueFull'),
            allowedMentions: { parse: [] },
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    if (wasEmpty) {
        log.debug('Queue etait vide, demarrage de la lecture');
        const playNextStart = Date.now();
        await queueManager.playNext(interaction.guildId!);
        log.debug(`request_to_playNext_ms=${Date.now() - playNextStart}`);
    }

    await interaction.editReply({
        content: t(locale, 'play.trackAdded', { title: safeContent(track.title) }),
        allowedMentions: { parse: [] },
    });
    deleteEphemeralAfterDelay(interaction);
}

function truncateString(str: string, maxLength: number): string {
    return truncate(str, maxLength);
}

async function deleteEphemeralAfterDelay(interaction: PlayInteraction): Promise<void> {
    const delayMs = Math.max(1, config.audio.ephemeralInfoDeleteDelay);
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            // Ignore
        }
    }, delayMs);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focusedValue = interaction.options.getFocused() as string;
    const query = focusedValue.trim();
    const locale = await resolveLocale(interaction.guildId, interaction.locale);

    if (!query) {
        await safeAutocompleteRespond(interaction, [
            {
                name: `✍️ ${t(locale, 'play.autocomplete.startTyping')}`,
                value: AUTOCOMPLETE_HINT_START_TYPING,
            },
        ]);
        return;
    }

    if (query.length < 2 && !youtubeService.isYouTubeUrl(query)) {
        await safeAutocompleteRespond(interaction, [
            {
                name: `⌨️ ${t(locale, 'play.autocomplete.refine')}`,
                value: AUTOCOMPLETE_HINT_REFINE,
            },
        ]);
        return;
    }

    if (youtubeService.isYouTubeUrl(query)) {
        await safeAutocompleteRespond(interaction, [{
            name: '\u200B',
            value: toAutocompleteValue(query),
        }]);
        return;
    }

    const key = getAutocompleteKey(interaction);
    const state = autocompleteState.get(key);
    const now = Date.now();

    if (state && state.lastQuery === query) {
        await safeAutocompleteRespond(interaction, state.lastOptions);
        return;
    }

    if (state && now - state.lastApiCallAt < AUTOCOMPLETE_DEBOUNCE_MS) {
        const throttledOptions = withHintOption(
            state.lastOptions,
            `⏳ ${t(locale, 'play.autocomplete.cooldown')}`,
            AUTOCOMPLETE_HINT_REFINE
        );
        await safeAutocompleteRespond(interaction, throttledOptions);
        return;
    }

    try {
        const results = await youtubeService.search(query, config.audio.searchResults);

        const options = results.map(r => ({
            name: truncateString(`${r.title} ${r.duration}`, 100),
            value: `https://www.youtube.com/watch?v=${r.id}`,
        }));

        const safeOptions = options.length > 0
            ? options
            : [{
                name: `🔎 ${t(locale, 'play.autocomplete.noResults')}`,
                value: AUTOCOMPLETE_HINT_NO_RESULTS,
            }];

        autocompleteState.set(key, {
            lastApiCallAt: Date.now(),
            lastQuery: query,
            lastOptions: safeOptions,
        });

        await safeAutocompleteRespond(interaction, safeOptions);
    } catch (error) {
        if (isKnownInteractionResponseError(error)) {
            log.warn('Autocomplete déjà traitée ou expirée, abandon.');
            return;
        }
        log.error('Erreur autocomplete:', error);
        await safeAutocompleteRespond(interaction, [
            {
                name: `⚠️ ${t(locale, 'error.generic')}`,
                value: AUTOCOMPLETE_HINT_REFINE,
            },
        ]);
    }
}

async function buildYouTubeUrlAutocompleteOptions(query: string, locale: 'en' | 'fr'): Promise<AutocompleteOption[]> {
    const optionValue = toAutocompleteValue(query);
    const options: AutocompleteOption[] = [
        {
            name: truncateString(`🔗 ${t(locale, 'play.autocomplete.keepUrl')}`, 100),
            value: optionValue,
        },
    ];

    const videoId = youtubeService.extractVideoId(query);
    if (videoId) {
        try {
            const info = await youtubeService.getVideoInfo(videoId);
            if (info) {
                options.push({
                    name: truncateString(
                        `🎵 ${t(locale, 'play.autocomplete.detected', {
                            title: safeContent(info.title),
                            duration: formatDuration(info.duration),
                        })}`,
                        100
                    ),
                    value: AUTOCOMPLETE_HINT_REFINE,
                });
                return options;
            }
        } catch (error) {
            log.trace('Impossible de resoudre le titre de l\'URL en autocomplete', error);
        }
    }

    return options;
}

function withHintOption(
    options: AutocompleteOption[],
    hintName: string,
    hintValue: string
): AutocompleteOption[] {
    const unique = options.filter(option => option.value !== hintValue);
    if (unique.length >= MAX_AUTOCOMPLETE_OPTIONS) {
        return unique.slice(0, MAX_AUTOCOMPLETE_OPTIONS);
    }

    return [
        ...unique,
        {
            name: truncateString(hintName, 100),
            value: hintValue,
        },
    ];
}

function isAutocompleteHintValue(value: string): boolean {
    return value.startsWith(AUTOCOMPLETE_HINT_PREFIX);
}

function formatDuration(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function toAutocompleteValue(query: string): string {
    if (query.length <= 100) {
        return query;
    }

    const videoId = youtubeService.extractVideoId(query);
    if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
    }

    const playlistId = youtubeService.extractPlaylistId(query);
    if (playlistId) {
        return `https://www.youtube.com/playlist?list=${playlistId}`;
    }

    return query.slice(0, 100);
}

function getAutocompleteKey(interaction: {
    guildId?: string | null;
    channelId?: string | null;
    user: { id: string };
}): string {
    const guildId = interaction.guildId ?? 'dm';
    const channelId = interaction.channelId ?? 'unknown-channel';
    return `${guildId}:${channelId}:${interaction.user.id}`;
}

async function safeAutocompleteRespond(
    interaction: { respond: (options: Array<{ name: string; value: string }>) => Promise<void> },
    options: Array<{ name: string; value: string }>,
    allowEmpty = false
): Promise<void> {
    try {
        const fallback = options.length > 0 || allowEmpty
            ? options
            : [{
                name: `✍️ ${t('fr', 'play.autocomplete.startTyping')}`,
                value: AUTOCOMPLETE_HINT_START_TYPING,
            }];
        await interaction.respond(fallback.slice(0, MAX_AUTOCOMPLETE_OPTIONS));
    } catch (error) {
        if (isKnownInteractionResponseError(error)) {
            return;
        }
        throw error;
    }
}
