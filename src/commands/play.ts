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
import type { Track } from '../types/index.js';

const log = logger.createModuleLogger('PlayCmd');

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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

        await interaction.editReply({
            content: `**${playlist.title}**\n${addedCount} piste${addedCount > 1 ? 's' : ''} ajoutee${addedCount > 1 ? 's' : ''} a la file d'attente.`,
        });
        deleteEphemeralAfterDelay(interaction);

        if (wasEmpty && addedCount > 0) {
            log.debug('Queue etait vide, demarrage de la lecture');
            await queueManager.playNext(interaction.guildId!);
        }
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

    await interaction.editReply({
        content: `**${track.title}** ajoutee a la file d'attente.`,
    });
    deleteEphemeralAfterDelay(interaction);

    if (wasEmpty) {
        log.debug('Queue etait vide, demarrage de la lecture');
        await queueManager.playNext(interaction.guildId!);
    }
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
    const focusedValue = interaction.options.getFocused();

    if (!focusedValue || focusedValue.length < 2) {
        await interaction.respond([]);
        return;
    }

    if (youtubeService.isYouTubeUrl(focusedValue)) {
        await interaction.respond([
            { name: 'Utiliser cette URL', value: focusedValue },
        ]);
        return;
    }

    try {
        const results = await youtubeService.search(focusedValue, config.audio.searchResults);

        const options = results.map(r => ({
            name: truncateString(`${r.title} ${r.duration}`, 100),
            value: `https://www.youtube.com/watch?v=${r.id}`,
        }));

        await interaction.respond(options);
    } catch (error) {
        log.error('Erreur autocomplete:', error);
        await interaction.respond([]);
    }
}
