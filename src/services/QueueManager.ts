import {
    joinVoiceChannel,
    createAudioPlayer,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    VoiceConnection,
    AudioPlayer,
    NoSubscriberBehavior,
    VoiceConnectionState,
    AudioPlayerState,
    AudioPlayerPlayingState,
    AudioPlayerPausedState,
    AudioResource,
} from '@discordjs/voice';
import type { VoiceChannel, StageChannel, TextChannel, Guild, GuildMember } from 'discord.js';
import { EventEmitter } from 'events';
import type { GuildQueue, Track } from '../types/index.js';
import { audioWrapper } from '../audio/AudioWrapper.js';
import { guildSettingsManager } from './GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('QueueManager');

class QueueManager extends EventEmitter {
    private queues: Map<string, GuildQueue> = new Map();
    private voiceChannelMonitors: Map<string, NodeJS.Timeout> = new Map();
    private crossfadeMonitors: Map<string, NodeJS.Timeout> = new Map();
    private intentionalConnectionDestroy: Map<string, VoiceConnection> = new Map();
    private activeResources: Map<string, AudioResource> = new Map();
    private transitionNonces: Map<string, number> = new Map();
    private warmedTrackByGuild: Map<string, string> = new Map();
    private lastTrackEndEvent: Map<string, { trackId: string | null; at: number }> = new Map();
    private transitionLocks: Map<string, Promise<void>> = new Map();
    private crossfadeAttemptsInFlight: Set<string> = new Set();
    private readonly crossfadeSeconds = 3;
    private readonly pipelineTeardownWaitMs = 120;

    constructor() {
        super();
        log.info('QueueManager initialisé');
    }

    /**
     * Obtient ou crée une file d'attente pour un serveur
     */
    getQueue(guildId: string): GuildQueue | undefined {
        return this.queues.get(guildId);
    }

    /**
     * Crée une nouvelle file d'attente pour un serveur
     */
    createQueue(
        guildId: string,
        textChannel: TextChannel,
        voiceChannel: VoiceChannel | StageChannel
    ): GuildQueue {
        log.debug(`Création de queue pour guild: ${guildId}`);
        log.trace(`TextChannel: ${textChannel.name} (${textChannel.id})`);
        log.trace(`VoiceChannel: ${voiceChannel.name} (${voiceChannel.id})`);

        const existingQueue = this.queues.get(guildId);
        if (existingQueue) {
            log.debug('Queue existante trouvée, réutilisation');
            return existingQueue;
        }

        const queue: GuildQueue = {
            guildId,
            textChannel,
            voiceChannel,
            connection: null,
            player: null,
            tracks: [],
            currentTrack: null,
            isPlaying: false,
            isPaused: false,
            isStopping: false,
            volume: 100,
            nowPlayingMessage: null,
            lyricsMessages: [],
            lyricsTrackId: null,
            startedAt: null,
            pausedAt: null,
            totalPausedTime: 0,
            autoPausedByEmptyChannel: false,
            crossfadeInProgress: false,
            crossfadeTargetTrackId: null,
        };

        this.queues.set(guildId, queue);
        log.info(`Queue créée pour guild: ${guildId}`);
        return queue;
    }

    /**
     * Supprime la file d'attente d'un serveur
     */
    deleteQueue(guildId: string): void {
        log.debug(`Suppression de queue pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        this.stopVoiceChannelMonitor(guildId);
        this.stopCrossfadeMonitor(guildId);
        if (queue) {
            this.teardownActiveResource(guildId);
            this.clearGuildWarmup(guildId);

            // Nettoyer les ressources
            if (queue.player) {
                log.trace('Arrêt du player');
                queue.isStopping = true;
                queue.player.stop(true);
            }
            if (queue.connection && queue.connection.state.status !== 'destroyed') {
                log.trace('Destruction de la connexion vocale');
                try {
                    this.markIntentionalConnectionDestroy(guildId, queue.connection);
                    queue.connection.destroy();
                } catch (error) {
                    log.trace('Connexion déjà détruite');
                }
            }
            if (queue.nowPlayingMessage) {
                log.trace('Suppression du message Now Playing');
                queue.nowPlayingMessage.delete().catch(() => {});
            }
            this.clearLyrics(queue);
            this.queues.delete(guildId);
            this.emit('queueDeleted', guildId);
            log.info(`Queue supprimée pour guild: ${guildId}`);
            this.intentionalConnectionDestroy.delete(guildId);
            this.transitionNonces.delete(guildId);
            this.lastTrackEndEvent.delete(guildId);
            this.crossfadeAttemptsInFlight.delete(guildId);
            this.transitionLocks.delete(guildId);
            void audioWrapper.cleanupGuildTemp(guildId);
        } else {
            log.warn(`Tentative de suppression d'une queue inexistante: ${guildId}`);
        }
    }

    /**
     * Rejoint un canal vocal et configure le lecteur audio
     */
    async joinChannel(queue: GuildQueue): Promise<VoiceConnection | null> {
        log.info(`Tentative de connexion au canal vocal: ${queue.voiceChannel.name} (${queue.voiceChannel.id})`);
        log.debug('Paramètres de connexion:', {
            channelId: queue.voiceChannel.id,
            guildId: queue.guildId,
            selfDeaf: true,
        });

        try {
            log.trace('Appel de joinVoiceChannel...');
            const connection = joinVoiceChannel({
                channelId: queue.voiceChannel.id,
                guildId: queue.guildId,
                adapterCreator: queue.voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: true,
            });

            log.debug(`Connexion créée, état actuel: ${connection.state.status}`);

            // Écouter tous les changements d'état de la connexion
            connection.on('stateChange', (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
                log.debug(`Connexion vocale: ${oldState.status} -> ${newState.status}`);
            });

            connection.on('error', (error) => {
                log.error('Erreur de connexion vocale:', error);
            });

            // Attendre que la connexion soit prête
            log.trace('Attente de l\'état Ready (timeout: 30s)...');
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                log.info('Connexion vocale établie avec succès!');
            } catch (error) {
                log.error('Timeout de connexion au canal vocal', error);
                log.debug(`État final de la connexion: ${connection.state.status}`);
                connection.destroy();
                return null;
            }

            // Créer le lecteur audio avec configuration
            log.trace('Création du lecteur audio...');
            const player = createAudioPlayer({
                behaviors: {
                    noSubscriber: NoSubscriberBehavior.Play, // Continue à jouer même sans subscriber
                },
            });

            // Écouter tous les changements d'état du player
            player.on('stateChange', (oldState: AudioPlayerState, newState: AudioPlayerState) => {
                log.debug(`Player audio: ${oldState.status} -> ${newState.status}`);
            });

            // Gérer les événements du lecteur
            player.on(AudioPlayerStatus.Idle, () => {
                log.debug('Player passé en Idle');
                this.handleTrackEnd(queue);
            });

            player.on(AudioPlayerStatus.Playing, () => {
                log.info(`Lecture demarree: ${queue.currentTrack?.title}`);
                queue.isPlaying = true;
                queue.isPaused = false;
                if (!queue.startedAt) {
                    queue.startedAt = Date.now();
                }
                queue.pausedAt = null;
                this.emit('trackStart', queue);
            });

            player.on(AudioPlayerStatus.Paused, () => {
                log.debug('Player mis en pause');
                queue.isPaused = true;
                queue.pausedAt = Date.now();
                this.emit('trackPaused', queue);
            });

            player.on(AudioPlayerStatus.Buffering, () => {
                log.debug('Player en buffering...');
            });

            player.on(AudioPlayerStatus.AutoPaused, () => {
                log.warn('Player auto-pausé (pas de subscriber?)');
            });

            player.on('error', (error) => {
                log.error('Erreur du player audio:', {
                    message: error.message,
                    resource: error.resource?.metadata,
                });
                this.handleTrackEnd(queue);
            });

            // S'abonner au lecteur
            log.trace('Abonnement du player à la connexion...');
            const subscription = connection.subscribe(player);
            if (subscription) {
                log.debug('Subscription créée avec succès');
            } else {
                log.warn('Échec de la création de la subscription!');
            }

            // Gérer la déconnexion
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                log.warn('Connexion vocale déconnectée, tentative de reconnexion...');
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    log.info('Reconnexion en cours...');
                } catch (error) {
                    log.error('Échec de reconnexion, suppression de la queue');
                    this.deleteQueue(queue.guildId);
                }
            });

            connection.on(VoiceConnectionStatus.Destroyed, () => {
                if (this.consumeIntentionalConnectionDestroy(queue.guildId, connection)) {
                    log.trace('Connexion vocale détruite volontairement');
                    return;
                }

                const activeQueue = this.queues.get(queue.guildId);
                if (!activeQueue) {
                    return;
                }

                if (activeQueue.connection !== connection) {
                    log.trace('Connexion détruite ignorée (connexion obsolète)');
                    return;
                }

                log.info('Connexion vocale détruite');
                this.deleteQueue(queue.guildId);
            });

            queue.connection = connection;
            queue.player = player;

            // Surveiller les membres du canal vocal
            this.startVoiceChannelMonitor(queue);
            this.startCrossfadeMonitor(queue);

            log.info('Configuration du canal vocal terminée avec succès');
            return connection;
        } catch (error) {
            log.error('Erreur lors de la connexion au canal vocal:', error);
            return null;
        }
    }

    /**
     * Surveille le canal vocal pour détecter quand il est vide
     */
    private startVoiceChannelMonitor(queue: GuildQueue): void {
        log.debug('Démarrage du monitoring du canal vocal');
        this.stopVoiceChannelMonitor(queue.guildId);

        const checkInterval = setInterval(async () => {
            const currentQueue = this.queues.get(queue.guildId);
            if (!currentQueue || !currentQueue.voiceChannel) {
                log.trace('Queue ou voiceChannel non trouvé, arrêt du monitoring');
                this.stopVoiceChannelMonitor(queue.guildId);
                return;
            }

            const voiceChannel = currentQueue.voiceChannel;
            const members = voiceChannel.members.filter(m => !m.user.bot);
            const settings = await guildSettingsManager.getSettings(queue.guildId);

            if (members.size === 0) {
                if (settings.stayConnectedAlways) {
                    if (
                        settings.pauseOnEmptyChannelWhenAlwaysConnected &&
                        currentQueue.isPlaying &&
                        !currentQueue.isPaused
                    ) {
                        const paused = this.pause(queue.guildId);
                        if (paused) {
                            currentQueue.autoPausedByEmptyChannel = true;
                            log.info(`Canal vide, pause automatique activée pour guild: ${queue.guildId}`);
                        }
                    } else {
                        log.debug('Canal vide mais stayConnectedAlways activé, maintien de la connexion');
                    }
                    return;
                }

                log.info(`Canal vocal vide, déconnexion de ${queue.guildId}`);
                this.stopVoiceChannelMonitor(queue.guildId);
                this.deleteQueue(queue.guildId);
                return;
            }

            if (
                settings.stayConnectedAlways &&
                settings.pauseOnEmptyChannelWhenAlwaysConnected &&
                currentQueue.autoPausedByEmptyChannel &&
                currentQueue.isPaused
            ) {
                const resumed = this.resume(queue.guildId);
                if (resumed) {
                    currentQueue.autoPausedByEmptyChannel = false;
                    log.info(`Membre revenu, reprise automatique pour guild: ${queue.guildId}`);
                }
                return;
            }

            if (!settings.pauseOnEmptyChannelWhenAlwaysConnected) {
                currentQueue.autoPausedByEmptyChannel = false;
            }
        }, 30_000);

        this.voiceChannelMonitors.set(queue.guildId, checkInterval);
    }

    /**
     * Ajoute une piste à la file d'attente
     */
    addTrack(guildId: string, track: Track): number {
        log.debug(`Ajout de piste: ${track.title}`);
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvée pour guild: ${guildId}`);
            return -1;
        }
        if (queue.tracks.length >= config.audio.maxQueueTracks) {
            log.warn(`Queue pleine (${config.audio.maxQueueTracks}), impossible d'ajouter: ${track.title}`);
            return 0;
        }


        queue.tracks.push(track);
        this.emit('trackAdded', queue, track);

        log.info(`Piste ajoutée à la queue (total: ${queue.tracks.length})`);
        log.trace('Détails de la piste:', track);

        this.refreshWarmup(queue);

        return 1;
    }

    /**
     * Ajoute plusieurs pistes à la file d'attente
     */
    addTracks(guildId: string, tracks: Track[]): number {
        log.debug(`Ajout de ${tracks.length} pistes`);
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvée pour guild: ${guildId}`);
            return -1;
        }
        const availableSlots = Math.max(0, config.audio.maxQueueTracks - queue.tracks.length);
        if (availableSlots == 0) {
            log.warn(`Queue pleine (${config.audio.maxQueueTracks}), aucune piste ajoutee`);
            return 0;
        }

        const tracksToAdd = tracks.slice(0, availableSlots);

        queue.tracks.push(...tracksToAdd);
        this.emit('tracksAdded', queue, tracksToAdd);

        log.info(`${tracksToAdd.length} pistes ajoutées à la queue (total: ${queue.tracks.length})`);

        this.refreshWarmup(queue);

        return tracksToAdd.length;
    }

    /**
     * Joue la prochaine piste de la file d'attente
     */
    async playNext(guildId: string): Promise<boolean> {
        return this.runWithTransitionLock(guildId, async () => this.playNextInternal(guildId));
    }

    private async playNextInternal(guildId: string): Promise<boolean> {
        const requestStartedAt = Date.now();
        log.debug(`playNext appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn('Queue non trouvee');
            return false;
        }
        const transitionNonce = this.bumpTransitionNonce(guildId);
        const isSessionStart = !queue.currentTrack;

        if (queue.tracks.length === 0) {
            log.info('File d\'attente vide');
            queue.currentTrack = null;
            queue.isPlaying = false;
            queue.autoPausedByEmptyChannel = false;
            queue.crossfadeInProgress = false;
            queue.crossfadeTargetTrackId = null;
            this.clearLyrics(queue);
            this.clearGuildWarmup(guildId);
            void audioWrapper.cleanupGuildTemp(guildId);
            this.emit('queueEmpty', queue);

            const settings = await guildSettingsManager.getSettings(guildId);
            if (!settings.stayConnected && !settings.stayConnectedAlways) {
                log.info('Déconnexion (queue vide, stay-connected désactivé)');
                this.deleteQueue(guildId);
            }

            return false;
        }

        if (queue.currentTrack) {
            this.clearLyrics(queue, queue.currentTrack.id);
        }

        const track = queue.tracks.shift()!;
        queue.currentTrack = track;
        queue.totalPausedTime = 0;
        queue.isStopping = false;
        queue.crossfadeInProgress = false;
        queue.crossfadeTargetTrackId = null;
        queue.autoPausedByEmptyChannel = false;

        log.info(`Prochaine piste: ${track.title}`);
        log.trace('Details:', track);

        if (isSessionStart) {
            await audioWrapper.cleanupGuildTemp(guildId);
        }

        const warmHit = audioWrapper.isTrackWarm(guildId, track.id);
        log.debug(`warmup_${warmHit ? 'hit' : 'miss'}: ${track.title}`);

        const resourceStartedAt = Date.now();
        const connectionPromise = !queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed
            ? this.joinChannel(queue)
            : Promise.resolve(queue.connection);
        const resourcePromise = audioWrapper.createResource(guildId, track);
        const [connection, resource] = await Promise.all([connectionPromise, resourcePromise]);
        log.debug(`resource_create_ms=${Date.now() - resourceStartedAt} (track: ${track.title})`);

        if (!this.isTransitionCurrent(guildId, transitionNonce)) {
            log.debug(`Transition obsolete ignoree pour ${guildId}`);
            if (resource) {
                audioWrapper.teardownResource(resource);
            }
            return false;
        }

        if (!connection) {
            log.error('Impossible de rejoindre le canal vocal');
            if (resource) {
                audioWrapper.teardownResource(resource);
            }
            return false;
        }

        if (!resource) {
            log.error(`Impossible de creer la ressource pour: ${track.title}`);
            return this.playNextInternal(guildId);
        }

        const settings = await guildSettingsManager.getSettings(guildId);
        const volume = Math.max(0, Math.min(200, settings.volume));
        queue.volume = volume;
        if (resource.volume) {
            resource.volume.setVolume(volume / 100);
        }

        log.debug('Ressource audio creee avec succes');
        log.trace('Type de ressource:', {
            playbackDuration: resource.playbackDuration,
            started: resource.started,
            ended: resource.ended,
        });

        if (queue.player) {
            this.teardownActiveResource(guildId);
            await this.waitForPipelineSettle();
            this.activeResources.set(guildId, resource);
            log.debug('Lancement de la lecture...');
            queue.player.play(resource);
            log.trace(`Etat du player apres play(): ${queue.player.state.status}`);
        } else {
            log.error('Player non disponible!');
            audioWrapper.teardownResource(resource);
            return false;
        }

        this.refreshWarmup(queue);
        log.debug(`request_to_play_ms=${Date.now() - requestStartedAt} (guild: ${guildId})`);

        return true;
    }

    /**
     * Déplace la connexion vers un autre canal vocal
     */
    async moveToChannel(queue: GuildQueue, voiceChannel: VoiceChannel | StageChannel): Promise<boolean> {
        if (queue.voiceChannel.id === voiceChannel.id && queue.connection) {
            return true;
        }

        queue.voiceChannel = voiceChannel;

        if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try {
                const rejoined = queue.connection.rejoin({
                    channelId: voiceChannel.id,
                    selfDeaf: true,
                    selfMute: false,
                });
                if (rejoined) {
                    log.info(`Déplacement vers ${voiceChannel.name}`);
                    return true;
                }
                log.warn('Rejoin échoué, tentative de reconnexion complète');
            } catch (error) {
                log.warn('Erreur lors du rejoin, tentative de reconnexion', error);
            }
        }

        if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try {
                this.markIntentionalConnectionDestroy(queue.guildId, queue.connection);
                queue.connection.destroy();
            } catch {
                // Ignore
            }
        }
        queue.connection = null;

        const connection = await this.joinChannel(queue);
        return !!connection;
    }

    setVolume(guildId: string, volume: number): boolean {
        const queue = this.queues.get(guildId);
        if (!queue) {
            return false;
        }

        const clamped = Math.max(0, Math.min(200, volume));
        queue.volume = clamped;

        const state = queue.player?.state;
        if (state?.status === AudioPlayerStatus.Playing || state?.status === AudioPlayerStatus.Paused) {
            const resource = (state as AudioPlayerPlayingState | AudioPlayerPausedState).resource;
            if (resource?.volume) {
                resource.volume.setVolume(clamped / 100);
            }
        }

        return true;
    }

    /**
     * Gere la fin d'une piste
     */
    private handleTrackEnd(queue: GuildQueue): void {
        const currentTrackId = queue.currentTrack?.id ?? null;
        const now = Date.now();
        const lastEvent = this.lastTrackEndEvent.get(queue.guildId);
        if (
            lastEvent &&
            lastEvent.trackId === currentTrackId &&
            now - lastEvent.at < 1_500
        ) {
            log.trace('Fin de piste dupliquee ignoree');
            return;
        }

        if (queue.crossfadeInProgress) {
            log.debug('Fin de piste ignorée (crossfade en cours)');
            return;
        }

        this.lastTrackEndEvent.set(queue.guildId, {
            trackId: currentTrackId,
            at: now,
        });

        log.debug('Fin de piste detectee');
        if (queue.isStopping) {
            log.debug('Fin de piste ignoree (stop en cours)');
            queue.isStopping = false;
            this.teardownActiveResource(queue.guildId);
            return;
        }

        this.teardownActiveResource(queue.guildId);
        queue.isPlaying = false;
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
        queue.crossfadeTargetTrackId = null;
        queue.startedAt = null;
        queue.pausedAt = null;
        queue.totalPausedTime = 0;
        const previousTrack = queue.currentTrack;

        if (previousTrack) {
            log.info(`Piste terminee: ${previousTrack.title}`);
            audioWrapper.clearFromCache(queue.guildId, previousTrack.id);
            this.clearLyrics(queue, previousTrack.id);
        }

        this.emit('trackEnd', queue, previousTrack);

        log.debug('Passage a la piste suivante...');
        void this.playNext(queue.guildId);
    }

    /**
     * Met en pause la lecture
     */
    pause(guildId: string): boolean {
        log.debug(`pause() appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue || !queue.player || queue.isPaused) {
            log.trace('Pause impossible (queue/player absent ou deja en pause)');
            return false;
        }

        queue.player.pause();
        queue.autoPausedByEmptyChannel = false;
        log.info('Lecture mise en pause');
        return true;
    }

    /**
     * Reprend la lecture
     */
    resume(guildId: string): boolean {
        log.debug(`resume() appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue || !queue.player || !queue.isPaused) {
            log.trace('Resume impossible');
            return false;
        }

        if (queue.pausedAt) {
            queue.totalPausedTime += Date.now() - queue.pausedAt;
            queue.pausedAt = null;
        }

        queue.player.unpause();
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
        log.info('Lecture reprise');
        return true;
    }

    /**
     * Avance ou recule la lecture vers un temps cible
     */
    async seekTo(guildId: string, targetSeconds: number): Promise<boolean> {
        return this.runWithTransitionLock(guildId, async () => {
            const queue = this.queues.get(guildId);
            if (!queue || !queue.player || !queue.currentTrack) {
                log.warn(`Seek impossible pour guild: ${guildId}`);
                return false;
            }

            const duration = queue.currentTrack.duration;
            const clamped = duration > 0
                ? Math.max(0, Math.min(Math.floor(targetSeconds), duration - 1))
                : Math.max(0, Math.floor(targetSeconds));

            log.info(`Seek vers ${clamped}s (piste: ${queue.currentTrack.title})`);

            const resource = await audioWrapper.createResource(guildId, queue.currentTrack, clamped);
            if (!resource) {
                log.error('Seek: impossible de créer la ressource audio');
                return false;
            }

            if (resource.volume) {
                resource.volume.setVolume(queue.volume / 100);
            }

            queue.totalPausedTime = 0;
            queue.pausedAt = null;
            queue.startedAt = Date.now() - clamped * 1000;
            queue.isPaused = false;
            queue.isStopping = false;

            this.bumpTransitionNonce(guildId);
            this.teardownActiveResource(guildId);
            await this.waitForPipelineSettle();
            this.activeResources.set(guildId, resource);
            queue.player.play(resource);
            return true;
        });
    }

    /**
     * Arrete la lecture et vide la file d'attente
     */
    stop(guildId: string): boolean {
        log.debug(`stop() appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn('Queue non trouvee');
            return false;
        }

        const trackCount = queue.tracks.length;
        queue.isStopping = true;
        queue.tracks = [];
        queue.currentTrack = null;
        queue.isPlaying = false;
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
        queue.crossfadeInProgress = false;
        queue.crossfadeTargetTrackId = null;
        queue.startedAt = null;
        queue.pausedAt = null;
        queue.totalPausedTime = 0;
        this.bumpTransitionNonce(guildId);
        this.teardownActiveResource(guildId);
        this.clearGuildWarmup(guildId);
        void audioWrapper.cleanupGuildTemp(guildId);

        if (queue.player) {
            queue.player.stop(true);
        }

        this.clearLyrics(queue);
        this.emit('queueStopped', queue);
        log.info(`Lecture arretee, ${trackCount} pistes supprimees de la queue`);
        setTimeout(() => {
            if (queue.isStopping) {
                queue.isStopping = false;
            }
        }, 1000);
        return true;
    }

    /**
     * Passe a la piste suivante
     */
    skip(guildId: string): boolean {
        log.debug(`skip() appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue || !queue.player) {
            log.trace('Skip impossible');
            return false;
        }

        log.info(`Skip de: ${queue.currentTrack?.title}`);
        queue.crossfadeInProgress = false;
        queue.crossfadeTargetTrackId = null;
        queue.autoPausedByEmptyChannel = false;
        this.bumpTransitionNonce(guildId);
        this.teardownActiveResource(guildId);
        queue.player.stop(true);
        return true;
    }

    /**
     * Supprime une piste de la file d'attente (index 0-based)
     */
    removeTrackAt(guildId: string, index: number): Track | null {
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvee pour guild: ${guildId}`);
            return null;
        }
        if (index < 0 || index >= queue.tracks.length) {
            log.warn(`Index hors limites pour suppression: ${index}`);
            return null;
        }

        const removed = queue.tracks.splice(index, 1)[0] ?? null;
        if (removed) {
            log.info(`Piste supprimee: ${removed.title}`);
        }
        this.refreshWarmup(queue);
        return removed;
    }

    /**
     * Supprime une plage de pistes (start inclus, end exclus)
     */
    removeTracksRange(guildId: string, start: number, end: number): number {
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvee pour guild: ${guildId}`);
            return 0;
        }
        const safeStart = Math.max(0, Math.min(start, queue.tracks.length));
        const safeEnd = Math.max(safeStart, Math.min(end, queue.tracks.length));
        const count = safeEnd - safeStart;
        if (count <= 0) return 0;

        queue.tracks.splice(safeStart, count);
        log.info(`Suppression de ${count} piste(s) de la queue`);
        this.refreshWarmup(queue);
        return count;
    }

    /**
     * Vide la file d'attente (sans stopper la lecture en cours)
     */
    clearUpcoming(guildId: string): number {
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvee pour guild: ${guildId}`);
            return 0;
        }
        const count = queue.tracks.length;
        queue.tracks = [];
        log.info(`File d'attente videe (${count} piste(s) supprimee(s))`);
        this.refreshWarmup(queue);
        return count;
    }

    /**
     * Deplace une piste dans la file d'attente
     */
    moveTrack(guildId: string, fromIndex: number, toIndex: number): boolean {
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn(`Queue non trouvee pour guild: ${guildId}`);
            return false;
        }
        if (fromIndex < 0 || fromIndex >= queue.tracks.length) {
            log.warn(`Index source hors limites: ${fromIndex}`);
            return false;
        }

        const clampedTo = Math.max(0, Math.min(toIndex, queue.tracks.length - 1));
        if (fromIndex === clampedTo) {
            return true;
        }

        const track = queue.tracks.splice(fromIndex, 1)[0];
        if (!track) return false;

        const insertAt = clampedTo >= queue.tracks.length ? queue.tracks.length : clampedTo;
        queue.tracks.splice(insertAt, 0, track);
        log.info(`Piste deplacee: ${track.title} (${fromIndex} -> ${insertAt})`);
        this.refreshWarmup(queue);
        return true;
    }
    /**
     * Supprime les messages de paroles en cours
     */
    clearLyrics(queue: GuildQueue, trackId?: string | null): void {
        if (queue.lyricsMessages.length === 0) {
            queue.lyricsTrackId = null;
            return;
        }

        if (trackId && queue.lyricsTrackId && queue.lyricsTrackId !== trackId) {
            return;
        }

        const messages = queue.lyricsMessages;
        queue.lyricsMessages = [];
        queue.lyricsTrackId = null;

        for (const message of messages) {
            message.delete().catch(() => {});
        }
    }

    /**
     * Obtient le temps de lecture actuel en secondes
     */
    getCurrentTime(guildId: string): number {
        const queue = this.queues.get(guildId);
        if (!queue || !queue.startedAt) return 0;

        const now = queue.isPaused && queue.pausedAt ? queue.pausedAt : Date.now();
        return Math.floor((now - queue.startedAt - queue.totalPausedTime) / 1000);
    }

    /**
     * Obtient toutes les files d'attente actives
     */
    getAllQueues(): Map<string, GuildQueue> {
        return this.queues;
    }

    /**
     * Vérifie si un serveur a une file d'attente active
     */
    hasQueue(guildId: string): boolean {
        return this.queues.has(guildId);
    }

    private bumpTransitionNonce(guildId: string): number {
        const next = (this.transitionNonces.get(guildId) ?? 0) + 1;
        this.transitionNonces.set(guildId, next);
        return next;
    }

    private isTransitionCurrent(guildId: string, nonce: number): boolean {
        return this.transitionNonces.get(guildId) === nonce;
    }

    private teardownActiveResource(guildId: string): void {
        const resource = this.activeResources.get(guildId);
        if (!resource) {
            return;
        }

        audioWrapper.teardownResource(resource);
        this.activeResources.delete(guildId);
    }

    private clearGuildWarmup(guildId: string): void {
        const warmedTrackId = this.warmedTrackByGuild.get(guildId);
        if (!warmedTrackId) {
            return;
        }

        audioWrapper.clearWarmResource(guildId, warmedTrackId);
        this.warmedTrackByGuild.delete(guildId);
    }

    private refreshWarmup(queue: GuildQueue): void {
        const nextTrack = queue.tracks[0] ?? null;
        const previousWarmTrackId = this.warmedTrackByGuild.get(queue.guildId);

        if (!nextTrack) {
            if (previousWarmTrackId) {
                audioWrapper.clearWarmResource(queue.guildId, previousWarmTrackId);
                this.warmedTrackByGuild.delete(queue.guildId);
            }
            void audioWrapper.preloadTracks(queue.guildId, []);
            return;
        }

        if (previousWarmTrackId && previousWarmTrackId !== nextTrack.id) {
            audioWrapper.clearWarmResource(queue.guildId, previousWarmTrackId);
        }

        this.warmedTrackByGuild.set(queue.guildId, nextTrack.id);
        void audioWrapper.preloadTracks(queue.guildId, [nextTrack]);
        void audioWrapper.warmTrack(queue.guildId, nextTrack);
    }

    private startCrossfadeMonitor(queue: GuildQueue): void {
        this.stopCrossfadeMonitor(queue.guildId);

        const interval = setInterval(() => {
            void this.maybeTriggerCrossfade(queue.guildId);
        }, 1_000);

        this.crossfadeMonitors.set(queue.guildId, interval);
    }

    private stopCrossfadeMonitor(guildId: string): void {
        const monitor = this.crossfadeMonitors.get(guildId);
        if (!monitor) {
            return;
        }

        clearInterval(monitor);
        this.crossfadeMonitors.delete(guildId);
    }

    private async maybeTriggerCrossfade(guildId: string): Promise<void> {
        const queue = this.queues.get(guildId);
        if (!queue || !queue.currentTrack || queue.tracks.length === 0 || queue.isPaused || !queue.isPlaying) {
            return;
        }
        if (!queue.player || queue.player.state.status !== AudioPlayerStatus.Playing) {
            return;
        }
        if (queue.crossfadeInProgress || this.crossfadeAttemptsInFlight.has(guildId)) {
            return;
        }
        if (!Number.isFinite(queue.currentTrack.duration) || queue.currentTrack.duration <= 0) {
            return;
        }

        const settings = await guildSettingsManager.getSettings(guildId);
        if (!settings.crossfadeEnabled) {
            return;
        }

        const currentTime = this.getCurrentTime(guildId);
        const remaining = queue.currentTrack.duration - currentTime;
        if (remaining > this.crossfadeSeconds + 0.25 || remaining <= 0) {
            return;
        }

        this.crossfadeAttemptsInFlight.add(guildId);
        try {
            await this.runWithTransitionLock(guildId, async () => this.triggerCrossfadeInternal(guildId));
        } finally {
            this.crossfadeAttemptsInFlight.delete(guildId);
        }
    }

    private async triggerCrossfadeInternal(guildId: string): Promise<boolean> {
        const queue = this.queues.get(guildId);
        if (!queue || !queue.player || !queue.currentTrack || queue.tracks.length === 0) {
            return false;
        }
        if (queue.crossfadeInProgress) {
            return false;
        }

        const currentTrack = queue.currentTrack;
        const previousStartedAt = queue.startedAt;
        const previousPausedAt = queue.pausedAt;
        const previousTotalPausedTime = queue.totalPausedTime;
        const nextTrack = queue.tracks.shift();
        if (!nextTrack) {
            return false;
        }

        queue.crossfadeInProgress = true;
        queue.crossfadeTargetTrackId = nextTrack.id;

        try {
            const currentOffsetSeconds = this.getCurrentTime(guildId);
            const resource = await audioWrapper.createCrossfadeResource(
                guildId,
                currentTrack,
                nextTrack,
                currentOffsetSeconds,
                this.crossfadeSeconds
            );

            if (!resource) {
                queue.tracks.unshift(nextTrack);
                queue.crossfadeInProgress = false;
                queue.crossfadeTargetTrackId = null;
                return false;
            }

            if (resource.volume) {
                resource.volume.setVolume(queue.volume / 100);
            }

            this.bumpTransitionNonce(guildId);
            this.teardownActiveResource(guildId);
            await this.waitForPipelineSettle();
            this.activeResources.set(guildId, resource);

            queue.currentTrack = nextTrack;
            queue.startedAt = Date.now();
            queue.pausedAt = null;
            queue.totalPausedTime = 0;
            queue.isPaused = false;
            queue.isPlaying = true;
            queue.autoPausedByEmptyChannel = false;

            audioWrapper.clearFromCache(guildId, currentTrack.id);
            this.clearLyrics(queue, currentTrack.id);
            this.emit('trackEnd', queue, currentTrack);

            queue.player.play(resource);
            setTimeout(() => {
                const latestQueue = this.queues.get(guildId);
                if (!latestQueue) {
                    return;
                }
                if (latestQueue.crossfadeTargetTrackId === nextTrack.id) {
                    latestQueue.crossfadeInProgress = false;
                    latestQueue.crossfadeTargetTrackId = null;
                }
            }, 500);
            this.refreshWarmup(queue);
            log.info(`Crossfade lancé: ${currentTrack.title} -> ${nextTrack.title}`);
            return true;
        } catch (error) {
            queue.currentTrack = currentTrack;
            queue.startedAt = previousStartedAt;
            queue.pausedAt = previousPausedAt;
            queue.totalPausedTime = previousTotalPausedTime;
            queue.isPlaying = true;
            queue.isPaused = !!previousPausedAt;
            queue.tracks.unshift(nextTrack);
            queue.crossfadeInProgress = false;
            queue.crossfadeTargetTrackId = null;
            log.warn('Crossfade indisponible, fallback en transition standard', error);
            return false;
        }
    }

    private stopVoiceChannelMonitor(guildId: string): void {
        const monitor = this.voiceChannelMonitors.get(guildId);
        if (!monitor) {
            return;
        }

        clearInterval(monitor);
        this.voiceChannelMonitors.delete(guildId);
    }

    private async runWithTransitionLock<T>(guildId: string, callback: () => Promise<T>): Promise<T> {
        const previous = this.transitionLocks.get(guildId) ?? Promise.resolve();

        let release: (() => void) | undefined;
        const current = new Promise<void>((resolve) => {
            release = () => resolve();
        });
        const pending = previous
            .catch(() => undefined)
            .then(() => current);

        this.transitionLocks.set(guildId, pending);
        await previous.catch(() => undefined);

        try {
            return await callback();
        } finally {
            if (release) {
                release();
            }
            const lock = this.transitionLocks.get(guildId);
            if (lock === pending) {
                this.transitionLocks.delete(guildId);
            }
        }
    }

    private async waitForPipelineSettle(): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, this.pipelineTeardownWaitMs);
        });
    }

    private markIntentionalConnectionDestroy(guildId: string, connection: VoiceConnection): void {
        this.intentionalConnectionDestroy.set(guildId, connection);
    }

    private consumeIntentionalConnectionDestroy(guildId: string, connection: VoiceConnection): boolean {
        const markedConnection = this.intentionalConnectionDestroy.get(guildId);
        if (!markedConnection || markedConnection !== connection) {
            return false;
        }

        this.intentionalConnectionDestroy.delete(guildId);
        return true;
    }
}

export const queueManager = new QueueManager();
