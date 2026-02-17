import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags,
    StageChannel,
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
import type { Track } from '../types/index.js';

const log = logger.createModuleLogger('PlayCmd');
const AUTOCOMPLETE_DEBOUNCE_MS = 1_500;
const AUTOCOMPLETE_HINT_PREFIX = '__hint_';
const AUTOCOMPLETE_HINT_START_TYPING = '__hint_start_typing__';
const AUTOCOMPLETE_HINT_REFINE = '__hint_refine_query__';
const AUTOCOMPLETE_HINT_NO_RESULTS = '__hint_no_results__';
const MAX_AUTOCOMPLETE_OPTIONS = 25;

type AutocompleteOption = { name: string; value: string };
type AutocompleteState = {
    lastApiCallAt: number;
    lastQuery: string;
    lastOptions: AutocompleteOption[];
};

const autocompleteState = new Map<string, AutocompleteState>();

export const data = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Joue une musique depuis YouTube')
    .setDMPermission(false)
    .addStringOption(option =>
        option
            .setName('query')
            .setDescription('URL YouTube ou termes de recherche')
            .setRequired(true)
            .setAutocomplete(true)
    );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
        });
        return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    log.debug(`Commande play par ${member.user.tag}`);

    // Vérification permissions
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: '❌ Vous n\'avez pas la permission d\'utiliser ce bot.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    if (!voiceChannel) {
        await interaction.reply({
            content: '❌ Vous devez être dans un canal vocal pour utiliser cette commande.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
        await interaction.reply({
            content: 'Commande indisponible ici.',
            flags: MessageFlags.Ephemeral,
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const query = interaction.options.getString('query', true);
    if (isAutocompleteHintValue(query)) {
        await interaction.reply({
            content: 'ℹ️ Cette option est une aide de saisie. Entrez un titre ou une URL YouTube puis validez.',
            flags: MessageFlags.Ephemeral,
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
            content: `❌ Je n'ai pas l'autorisation de rejoindre <#${targetChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
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
            await handleYouTubeUrl(interaction, query, member, targetChannel, textChannel);
        } else {
            log.debug('Detecte comme recherche (auto)');
            await handleSearchAuto(interaction, query, member, targetChannel, textChannel);
        }
    } catch (error) {
        log.error('Erreur:', error);
        await interaction.editReply({
            content: 'Une erreur est survenue lors du traitement de votre demande.',
        });
        deleteEphemeralAfterDelay(interaction);
    }
}

async function handleYouTubeUrl(
    interaction: ChatInputCommandInteraction,
    url: string,
    member: GuildMember,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel
): Promise<void> {
    if (youtubeService.isPlaylistUrl(url)) {
        log.debug('URL de playlist detectee');
        const playlistId = youtubeService.extractPlaylistId(url);
        if (!playlistId) {
            log.warn('ID de playlist invalide');
            await interaction.editReply({
                content: 'URL de playlist invalide.',
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }

        await interaction.editReply({
            content: 'Chargement de la playlist...',
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
                content: 'Playlist introuvable ou vide.',
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
                    content: `❌ Je n'ai pas l'autorisation de rejoindre <#${voiceChannel.id}>.`,
                });
                deleteEphemeralAfterDelay(interaction);
                return;
            }
            const moved = await queueManager.moveToChannel(queue, voiceChannel);
            if (!moved) {
                await interaction.editReply({
                    content: '❌ Impossible de déplacer le bot vers le canal préféré.',
                });
                deleteEphemeralAfterDelay(interaction);
                return;
            }
        }

        const wasEmpty = queue.tracks.length === 0 && !queue.currentTrack;
        const addedCount = queueManager.addTracks(interaction.guildId!, tracks);

        if (addedCount <= 0) {
            await interaction.editReply({
                content: 'File d\'attente pleine.',
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
            content: `**${playlist.title}**\n${addedCount} piste${addedCount > 1 ? 's' : ''} ajoutee${addedCount > 1 ? 's' : ''} a la file d'attente.`,
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
            content: 'Impossible de charger cette video.',
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    log.info(`Track cree: ${track.title}`);
    await addTrackToQueue(interaction, track, voiceChannel, textChannel);
}

async function handleSearchAuto(
    interaction: ChatInputCommandInteraction,
    query: string,
    member: GuildMember,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel
): Promise<void> {
    await interaction.editReply({
        content: `Recherche de "${query}"...`,
    });

    log.debug(`Recherche YouTube (auto): ${query}`);
    const results = await youtubeService.search(query, config.audio.searchResults);

    if (results.length === 0) {
        log.debug('Aucun resultat (auto)');
        await interaction.editReply({
            content: 'Aucun resultat trouve.',
        });
        deleteEphemeralAfterDelay(interaction);
        return;
    }

    const selectedResult = results[0];
    log.info(`Auto-selectionne: ${selectedResult.title}`);

    const track = await youtubeService.createTrackFromSearch(
        selectedResult,
        member.displayName,
        member.id
    );

    await addTrackToQueue(interaction, track, voiceChannel, textChannel);
}

async function addTrackToQueue(
    interaction: ChatInputCommandInteraction,
    track: Track,
    voiceChannel: VoiceChannel | StageChannel,
    textChannel: TextChannel
): Promise<void> {
    let queue = queueManager.getQueue(interaction.guildId!);
    if (!queue) {
        log.debug('Creation d\'une nouvelle queue');
        queue = queueManager.createQueue(interaction.guildId!, textChannel, voiceChannel);
    } else if (queue.voiceChannel.id !== voiceChannel.id) {
        if (!(await canJoinVoiceChannel(voiceChannel, interaction.guildId!))) {
            await interaction.editReply({
                content: `❌ Je n'ai pas l'autorisation de rejoindre <#${voiceChannel.id}>.`,
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }
        const moved = await queueManager.moveToChannel(queue, voiceChannel);
        if (!moved) {
            await interaction.editReply({
                content: '❌ Impossible de déplacer le bot vers le canal préféré.',
            });
            deleteEphemeralAfterDelay(interaction);
            return;
        }
    }

    const wasEmpty = queue.tracks.length === 0 && !queue.currentTrack;
    const added = queueManager.addTrack(interaction.guildId!, track);
    if (added <= 0) {
        await interaction.editReply({
            content: 'File d\'attente pleine.',
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
        content: `**${track.title}** ajoutee a la file d'attente.`,
    });
    deleteEphemeralAfterDelay(interaction);
}

function truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

async function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): Promise<void> {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            // Ignore
        }
    }, config.audio.ephemeralInfoDeleteDelay);
}

export async function autocomplete(interaction: any): Promise<void> {
    const focusedValue = interaction.options.getFocused() as string;
    const query = focusedValue.trim();

    if (!query) {
        await safeAutocompleteRespond(interaction, [
            {
                name: '✍️ Commence a ecrire un titre ou colle une URL YouTube',
                value: AUTOCOMPLETE_HINT_START_TYPING,
            },
        ]);
        return;
    }

    if (query.length < 2 && !youtubeService.isYouTubeUrl(query)) {
        await safeAutocompleteRespond(interaction, [
            {
                name: '⌨️ Continue a ecrire pour lancer la recherche',
                value: AUTOCOMPLETE_HINT_REFINE,
            },
        ]);
        return;
    }

    // URL YouTube: l'option par défaut conserve l'URL saisie.
    if (youtubeService.isYouTubeUrl(query)) {
        const urlOptions = await buildYouTubeUrlAutocompleteOptions(query);
        await safeAutocompleteRespond(interaction, urlOptions);
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
            '⏳ Pause 1.5s apres la derniere frappe pour affiner',
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
                name: '🔎 Aucun resultat, continue a ecrire pour preciser',
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
                name: '⚠️ Recherche indisponible, reessaie dans un instant',
                value: AUTOCOMPLETE_HINT_REFINE,
            },
        ]);
    }
}

async function buildYouTubeUrlAutocompleteOptions(query: string): Promise<AutocompleteOption[]> {
    const optionValue = toAutocompleteValue(query);
    const options: AutocompleteOption[] = [
        {
            name: truncateString('🔗 Garder cette URL (ne remplace pas la saisie)', 100),
            value: optionValue,
        },
    ];

    const videoId = youtubeService.extractVideoId(query);
    if (videoId) {
        try {
            const info = await youtubeService.getVideoInfo(videoId);
            if (info) {
                options.push({
                    name: truncateString(`🎵 Titre detecte: ${info.title} • ${formatDuration(info.duration)}`, 100),
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
    options: Array<{ name: string; value: string }>
): Promise<void> {
    try {
        const fallback = options.length > 0
            ? options
            : [{
                name: '✍️ Commence a ecrire un titre ou colle une URL YouTube',
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
