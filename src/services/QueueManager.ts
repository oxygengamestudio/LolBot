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
import type { VoiceChannel, StageChannel, TextChannel, VoiceState } from 'discord.js';
import { EventEmitter } from 'events';
import type { GuildQueue, Track } from '../types/index.js';
import { audioWrapper } from '../audio/AudioWrapper.js';
import { mediaCacheManager } from '../audio/MediaCacheManager.js';
import { guildSettingsManager } from './GuildSettingsManager.js';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('QueueManager');

class QueueManager extends EventEmitter {
    private queues: Map<string, GuildQueue> = new Map();
    private voiceChannelMonitors: Map<string, NodeJS.Timeout> = new Map();
    private crossfadeMonitors: Map<string, NodeJS.Timeout> = new Map();
    private intentionalConnectionDestroy: Map<string, Set<VoiceConnection>> = new Map();
    private activeResources: Map<string, AudioResource> = new Map();
    private resourceSwapInProgress: Set<string> = new Set();
    private retiredResources: Map<string, NodeJS.Timeout> = new Map();
    private transitionNonces: Map<string, number> = new Map();
    private warmedTrackByGuild: Map<string, string> = new Map();
    private lastTrackEndEvent: Map<string, { trackId: string | null; at: number }> = new Map();
    private transitionLocks: Map<string, Promise<void>> = new Map();
    private connectionAttempts: Map<string, Promise<VoiceConnection | null>> = new Map();
    private crossfadeAttemptsInFlight: Set<string> = new Set();
    private readonly crossfadeSeconds = 3;
    private readonly crossfadePrepareLeadSeconds = 1.5;
    private readonly pipelineTeardownWaitMs = 120;
    private readonly retiredResourceRetentionMs = 10_000;
    private readonly voiceDebugLogs = ['1', 'true', 'yes', 'on'].includes(
        (process.env.VOICE_DEBUG_LOGS ?? '').toLowerCase()
    );

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
            isReconnecting: false,
            reconnectAttempts: 0,
            shouldKeepConnection: false,
            isManualDisconnect: false,
            crossfadeInProgress: false,
            crossfadeTargetTrackId: null,
            lastStartMetrics: null,
        };

        this.queues.set(guildId, queue);
        log.info(`Queue créée pour guild: ${guildId}`);
        return queue;
    }

    /**
     * Supprime la file d'attente d'un serveur
     */
    deleteQueue(guildId: string, manualDisconnect: boolean = false): void {
        log.debug(`Suppression de queue pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        this.stopVoiceChannelMonitor(guildId);
        this.stopCrossfadeMonitor(guildId);
        if (queue) {
            queue.isManualDisconnect = manualDisconnect;
            queue.isReconnecting = false;
            queue.reconnectAttempts = 0;
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
            this.connectionAttempts.delete(guildId);
            this.resourceSwapInProgress.delete(guildId);
            this.clearRetiredResources(guildId);
            void audioWrapper.cleanupGuildTemp(guildId);
            void this.pruneCache();
        } else {
            log.warn(`Tentative de suppression d'une queue inexistante: ${guildId}`);
        }
    }

    /**
     * Rejoint un canal vocal et configure le lecteur audio
     */
    async joinChannel(queue: GuildQueue): Promise<VoiceConnection | null> {
        const existingAttempt = this.connectionAttempts.get(queue.guildId);
        if (existingAttempt) {
            log.debug(`Connexion vocale déjà en cours pour guild: ${queue.guildId}`);
            return existingAttempt;
        }

        const attempt = this.joinChannelInternal(queue);
        this.connectionAttempts.set(queue.guildId, attempt);
        try {
            return await attempt;
        } finally {
            if (this.connectionAttempts.get(queue.guildId) === attempt) {
                this.connectionAttempts.delete(queue.guildId);
            }
        }
    }

    private async joinChannelInternal(queue: GuildQueue): Promise<VoiceConnection | null> {
        log.info(`Tentative de connexion au canal vocal: ${queue.voiceChannel.name} (${queue.voiceChannel.id})`);
        log.debug('Paramètres de connexion:', {
            channelId: queue.voiceChannel.id,
            guildId: queue.guildId,
            selfDeaf: true,
        });

        this.ensurePlayer(queue);

        const maxAttempts = 3;
        const readyTimeoutMs = 10_000;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (this.queues.get(queue.guildId) !== queue) {
                log.trace('Connexion vocale abandonnée: queue remplacée ou supprimée');
                return null;
            }

            if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                this.destroyConnection(queue.guildId, queue.connection);
                queue.connection = null;
            }

            try {
                log.trace(`Appel de joinVoiceChannel (tentative ${attempt}/${maxAttempts})...`);
                const joinOptions: Parameters<typeof joinVoiceChannel>[0] & { daveEncryption?: boolean } = {
                    channelId: queue.voiceChannel.id,
                    guildId: queue.guildId,
                    adapterCreator: queue.voiceChannel.guild.voiceAdapterCreator,
                    debug: true,
                    daveEncryption: true,
                    selfDeaf: true,
                };
                const connection = joinVoiceChannel(joinOptions);

                queue.connection = connection;
                this.attachConnectionListeners(queue, connection);
                log.debug(`Connexion créée, état actuel: ${connection.state.status}`);
                log.trace(`Attente de l'état Ready (timeout: ${readyTimeoutMs}ms)...`);

                await entersState(connection, VoiceConnectionStatus.Ready, readyTimeoutMs);

                if (queue.player) {
                    const subscription = connection.subscribe(queue.player);
                    if (subscription) {
                        log.debug('Subscription créée avec succès');
                    } else {
                        log.warn('Échec de la création de la subscription!');
                    }
                }

                this.startVoiceChannelMonitor(queue);
                queue.shouldKeepConnection = true;
                queue.isManualDisconnect = false;
                queue.isReconnecting = false;
                queue.reconnectAttempts = 0;
                log.info(`Connexion vocale établie avec succès en ${attempt} tentative(s)!`);
                return connection;
            } catch (error) {
                lastError = error;
                const activeConnection = queue.connection;
                log.warn(`Echec de connexion vocale (tentative ${attempt}/${maxAttempts})`, {
                    status: activeConnection?.state.status ?? 'none',
                    message: (error as Error)?.message ?? String(error),
                });
                if (activeConnection) {
                    this.destroyConnection(queue.guildId, activeConnection);
                }
                queue.connection = null;

                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 750));
                }
            }
        }

        log.error('Impossible de rejoindre le canal vocal apres retries', lastError);
        return null;
    }

    /**
     * Surveille le canal vocal pour détecter quand il est vide
     */
    private startVoiceChannelMonitor(queue: GuildQueue): void {
        this.stopVoiceChannelMonitor(queue.guildId);
        const timer = setTimeout(() => {
            void this.evaluateVoiceChannel(queue.guildId);
        }, 3_000);
        this.voiceChannelMonitors.set(queue.guildId, timer);
    }

    handleVoiceStateChange(oldState: VoiceState, newState: VoiceState): void {
        const guildId = newState.guild.id;
        const queue = this.queues.get(guildId);
        if (!queue) {
            return;
        }

        const botUserId = newState.client.user?.id ?? oldState.client.user?.id;
        const isBotVoiceState = !!botUserId && (oldState.id === botUserId || newState.id === botUserId);
        if (isBotVoiceState && oldState.channelId === queue.voiceChannel.id) {
            if (newState.channelId && newState.channelId !== queue.voiceChannel.id && newState.channel?.isVoiceBased()) {
                queue.voiceChannel = newState.channel as VoiceChannel | StageChannel;
                this.startVoiceChannelMonitor(queue);
                log.info(`Bot déplacé vers le canal vocal: ${queue.voiceChannel.name} (${queue.voiceChannel.id})`);
                return;
            }

            if (!newState.channelId && !queue.isManualDisconnect) {
                if (queue.isReconnecting || this.connectionAttempts.has(guildId)) {
                    log.trace('Déconnexion vocale déjà en cours de récupération, événement ignoré');
                    return;
                }

                const resumeOffset = queue.currentTrack ? this.getCurrentTime(guildId) : 0;
                log.warn('Bot retiré du canal vocal, tentative de reconnexion...');
                void this.reconnectWithBackoff(queue, resumeOffset).then((reconnected) => {
                    if (!reconnected && !queue.isManualDisconnect && this.queues.get(guildId) === queue) {
                        this.deleteQueue(guildId, false);
                    }
                });
                return;
            }
        }

        if (oldState.channelId !== queue.voiceChannel.id && newState.channelId !== queue.voiceChannel.id) {
            return;
        }

        this.startVoiceChannelMonitor(queue);
    }

    private async evaluateVoiceChannel(guildId: string): Promise<void> {
        const queue = this.queues.get(guildId);
        if (!queue) {
            this.stopVoiceChannelMonitor(guildId);
            return;
        }

        const members = queue.voiceChannel.members.filter((member) => !member.user.bot);
        const settings = await guildSettingsManager.getSettings(guildId);

        if (members.size === 0) {
            if (settings.stayConnectedAlways) {
                if (
                    settings.pauseOnEmptyChannelWhenAlwaysConnected &&
                    queue.isPlaying &&
                    !queue.isPaused
                ) {
                    const paused = this.pause(guildId);
                    if (paused) {
                        queue.autoPausedByEmptyChannel = true;
                        log.info(`Canal vide, pause automatique activée pour guild: ${guildId}`);
                    }
                }
                return;
            }

            log.info(`Canal vocal vide, déconnexion de ${guildId}`);
            this.deleteQueue(guildId);
            return;
        }

        if (
            settings.stayConnectedAlways &&
            settings.pauseOnEmptyChannelWhenAlwaysConnected &&
            queue.autoPausedByEmptyChannel &&
            queue.isPaused
        ) {
            const resumed = this.resume(guildId);
            if (resumed) {
                queue.autoPausedByEmptyChannel = false;
                log.info(`Membre revenu, reprise automatique pour guild: ${guildId}`);
            }
        }
    }

    private ensurePlayer(queue: GuildQueue): void {
        if (queue.player) {
            return;
        }

        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
            },
        });

        player.on('stateChange', (oldState: AudioPlayerState, newState: AudioPlayerState) => {
            log.debug(`Player audio: ${oldState.status} -> ${newState.status}`);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            if (this.resourceSwapInProgress.has(queue.guildId)) {
                log.trace('Player idle ignoré (swap de ressource en cours)');
                return;
            }
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
            this.startCrossfadeMonitor(queue);
            this.emit('trackStart', queue);
        });

        player.on(AudioPlayerStatus.Paused, () => {
            log.debug('Player mis en pause');
            queue.isPaused = true;
            queue.pausedAt = Date.now();
            this.stopCrossfadeMonitor(queue.guildId);
            this.emit('trackPaused', queue);
        });

        player.on(AudioPlayerStatus.Buffering, () => {
            log.debug('Player en buffering...');
        });

        player.on(AudioPlayerStatus.AutoPaused, () => {
            log.warn('Player auto-pause');
        });

        player.on('error', (error) => {
            if (this.shouldIgnorePlayerResourceError(queue.guildId, error.resource)) {
                log.debug('Erreur du player ignorée (ancienne ressource)', {
                    message: error.message,
                    resource: error.resource?.metadata,
                });
                return;
            }

            log.error('Erreur du player audio:', {
                message: error.message,
                resource: error.resource?.metadata,
            });
            this.handleTrackEnd(queue);
        });

        queue.player = player;
    }

    private attachConnectionListeners(queue: GuildQueue, connection: VoiceConnection): void {
        connection.on('stateChange', (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
            log.debug(`Connexion vocale: ${oldState.status} -> ${newState.status}`, {
                rejoinAttempts: connection.rejoinAttempts,
                closeCode: 'closeCode' in newState ? newState.closeCode : undefined,
                reason: 'reason' in newState ? newState.reason : undefined,
            });
        });

        if (this.voiceDebugLogs) {
            connection.on('debug', (message) => {
                log.trace(`[voice] ${message}`);
            });
        }

        connection.on('error', (error) => {
            log.error('Erreur de connexion vocale:', error);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            const activeQueue = this.queues.get(queue.guildId);
            if (!activeQueue || activeQueue.connection !== connection) {
                return;
            }
            if (activeQueue.isReconnecting) {
                log.trace('Déconnexion ignorée, reconnexion déjà active');
                return;
            }
            if (activeQueue.isManualDisconnect) {
                log.trace('Déconnexion manuelle détectée, aucun reconnect');
                return;
            }

            log.warn('Connexion vocale déconnectée, tentative de récupération...');
            const resumeOffset = activeQueue.currentTrack ? this.getCurrentTime(queue.guildId) : 0;
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 900);
                if (activeQueue.connection === connection && activeQueue.player) {
                    connection.subscribe(activeQueue.player);
                }
                log.info('Connexion vocale récupérée par Discord');
            } catch (error) {
                log.warn('Récupération simple échouée, tentative de reconnexion complète', error);
                const reconnected = await this.reconnectWithBackoff(activeQueue, resumeOffset);
                if (!reconnected) {
                    this.deleteQueue(queue.guildId, false);
                }
            }
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (this.consumeIntentionalConnectionDestroy(queue.guildId, connection)) {
                log.trace('Connexion vocale détruite volontairement');
                return;
            }

            const activeQueue = this.queues.get(queue.guildId);
            if (!activeQueue || activeQueue.connection !== connection) {
                return;
            }

            if (activeQueue.isReconnecting) {
                log.trace('Connexion détruite pendant une reconnexion déjà active');
                return;
            }

            log.info('Connexion vocale détruite involontairement');
            void this.reconnectWithBackoff(activeQueue, activeQueue.currentTrack ? this.getCurrentTime(queue.guildId) : 0)
                .then((reconnected) => {
                    if (!reconnected && !activeQueue.isManualDisconnect && this.queues.get(queue.guildId) === activeQueue) {
                        this.deleteQueue(queue.guildId, false);
                    }
                });
        });
    }

    private destroyConnection(guildId: string, connection: VoiceConnection): void {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) {
            return;
        }

        try {
            this.markIntentionalConnectionDestroy(guildId, connection);
            connection.destroy();
        } catch {
            // Ignore.
        }
    }

    private async reconnectWithBackoff(queue: GuildQueue, resumeOffset: number): Promise<boolean> {
        if (queue.isManualDisconnect) {
            return false;
        }
        if (queue.isReconnecting) {
            return true;
        }

        queue.isReconnecting = true;
        if (queue.connection && queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.destroyConnection(queue.guildId, queue.connection);
        }
        queue.connection = null;

        const hasPlayableWork = !!queue.currentTrack || queue.tracks.length > 0 || queue.shouldKeepConnection;
        if (!hasPlayableWork) {
            queue.isReconnecting = false;
            return false;
        }

        try {
            for (let attempt = 1; attempt <= config.audio.voiceReconnectMaxAttempts; attempt += 1) {
                if (attempt > 1) {
                    const delayMs = Math.min(
                        config.audio.voiceReconnectMaxDelayMs,
                        config.audio.voiceReconnectBaseDelayMs * 2 ** (attempt - 2)
                    );
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }

                if (queue.isManualDisconnect || !this.queues.has(queue.guildId)) {
                    return false;
                }

                queue.reconnectAttempts = attempt;
                const connection = await this.joinChannel(queue);
                if (!connection) {
                    log.warn(`Tentative de reconnexion échouée (#${attempt}/${config.audio.voiceReconnectMaxAttempts})`);
                    continue;
                }

                queue.isReconnecting = false;
                queue.reconnectAttempts = 0;

                if (queue.currentTrack && this.reattachActivePlayback(queue, resumeOffset)) {
                    return true;
                }
                if (queue.currentTrack) {
                    return this.resumeCurrentTrack(queue, resumeOffset);
                }
                if (queue.tracks.length > 0) {
                    return this.playNext(queue.guildId);
                }
                return true;
            }
        } finally {
            queue.isReconnecting = false;
        }

        return false;
    }

    private async resumeCurrentTrack(queue: GuildQueue, resumeOffset: number): Promise<boolean> {
        if (!queue.currentTrack || !queue.player) {
            return false;
        }

        const settings = await guildSettingsManager.getSettings(queue.guildId);
        const resource = await audioWrapper.createResource(
            queue.guildId,
            queue.currentTrack,
            Math.max(0, resumeOffset),
            settings.sponsorBlockEnabled,
            queue.volume
        );
        if (!resource) {
            return false;
        }

        if (resource.volume) {
            resource.volume.setVolume(queue.volume / 100);
        }

        queue.startedAt = Date.now() - Math.max(0, resumeOffset) * 1000;
        queue.pausedAt = null;
        queue.totalPausedTime = 0;
        queue.isPaused = false;
        queue.isStopping = false;
        await this.replaceActiveResource(queue, resource);
        this.startCrossfadeMonitor(queue);
        return true;
    }

    private reattachActivePlayback(queue: GuildQueue, resumeOffset: number): boolean {
        if (!queue.currentTrack || !queue.player || !queue.connection) {
            return false;
        }
        if (queue.connection.state.status !== VoiceConnectionStatus.Ready) {
            return false;
        }
        if (this.getActiveResourceTrackId(queue.guildId) !== queue.currentTrack.id) {
            return false;
        }

        const status = queue.player.state.status;
        if (status === AudioPlayerStatus.Idle) {
            return false;
        }

        try {
            queue.connection.subscribe(queue.player);
        } catch (error) {
            log.trace('Ré-attache du player impossible', error);
            return false;
        }

        const currentOffset = this.getCurrentTime(queue.guildId);
        const safeOffset = Math.max(0, currentOffset, resumeOffset);
        queue.startedAt = Date.now() - safeOffset * 1000;
        queue.totalPausedTime = 0;
        queue.pausedAt = status === AudioPlayerStatus.Paused ? Date.now() : null;
        queue.isPaused = status === AudioPlayerStatus.Paused;
        queue.isPlaying = true;
        queue.isStopping = false;
        queue.isManualDisconnect = false;
        queue.autoPausedByEmptyChannel = false;

        if (status === AudioPlayerStatus.AutoPaused) {
            queue.player.unpause();
            queue.isPaused = false;
            queue.pausedAt = null;
        }

        this.startCrossfadeMonitor(queue);
        this.emit('trackStart', queue);
        log.info(`Lecture ré-attachée après reconnexion: ${queue.currentTrack.title}`);
        return true;
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
        queue.isManualDisconnect = false;
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
        queue.isManualDisconnect = false;
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

    private attachWarmupMetrics(
        guildId: string,
        track: Track,
        warmHit: boolean,
        warmupPromise: Promise<number | null>
    ): void {
        if (warmHit) {
            return;
        }

        void warmupPromise.then((warmupMs) => {
            const activeQueue = this.queues.get(guildId);
            if (!activeQueue || activeQueue.currentTrack?.id !== track.id || !activeQueue.lastStartMetrics) {
                return;
            }

            activeQueue.lastStartMetrics.warmupMs = warmupMs;
        });
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
            queue.shouldKeepConnection = false;
            queue.autoPausedByEmptyChannel = false;
            queue.crossfadeInProgress = false;
            queue.crossfadeTargetTrackId = null;
            this.stopCrossfadeMonitor(guildId);
            this.clearLyrics(queue);
            this.clearGuildWarmup(guildId);
            void audioWrapper.cleanupGuildTemp(guildId);
            this.emit('queueEmpty', queue);

            const settings = await guildSettingsManager.getSettings(guildId);
            if (!settings.stayConnected && !settings.stayConnectedAlways) {
                log.info('Déconnexion (queue vide, stay-connected désactivé)');
                this.deleteQueue(guildId, false);
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
        queue.isManualDisconnect = false;
        queue.shouldKeepConnection = true;
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
        const warmupPromise = Promise.resolve<number | null>(warmHit ? 0 : null);

        let joinMs: number | null = null;
        const warmupMs: number | null = warmHit ? 0 : null;
        let connection: VoiceConnection | null = null;
        let resource: AudioResource | null = null;
        const hasReadyConnection =
            !!queue.connection &&
            queue.connection.state.status !== VoiceConnectionStatus.Destroyed &&
            queue.connection.state.status === VoiceConnectionStatus.Ready;

        const resourceStartedAt = Date.now();
        const resourcePromise = guildSettingsManager.getSettings(guildId)
            .then((settings) => audioWrapper.createResource(guildId, track, 0, settings.sponsorBlockEnabled, settings.volume));

        if (!hasReadyConnection) {
            const joinStartedAt = Date.now();
            const [joinedConnection, resourceResult] = await Promise.all([
                this.joinChannel(queue),
                resourcePromise,
            ]);
            connection = joinedConnection;
            resource = resourceResult;
            joinMs = Date.now() - joinStartedAt;
        } else {
            connection = queue.connection;
            joinMs = 0;
            resource = await resourcePromise;
        }

        const resourceMs = Date.now() - resourceStartedAt;
        log.debug(`resource_create_ms=${resourceMs} (track: ${track.title})`);
        queue.lastStartMetrics = {
            joinMs,
            warmupMs,
            resourceMs,
            warmHit,
            sourceMode: audioWrapper.getLastSourceMode(guildId),
        };

        if (!connection) {
            log.error('Impossible de rejoindre le canal vocal');
            if (resource) {
                audioWrapper.teardownResource(resource);
            }
            return false;
        }

        this.attachWarmupMetrics(guildId, track, warmHit, warmupPromise);

        if (!this.isTransitionCurrent(guildId, transitionNonce)) {
            log.debug(`Transition obsolete ignoree pour ${guildId}`);
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
            await this.replaceActiveResource(queue, resource);
            log.debug('Lancement de la lecture...');
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
        queue.isManualDisconnect = false;

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
                this.destroyConnection(queue.guildId, queue.connection);
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
        let applied = false;

        const activeResource = this.activeResources.get(guildId);
        if (activeResource?.volume) {
            activeResource.volume.setVolume(clamped / 100);
            applied = true;
        }

        const state = queue.player?.state;
        if (state?.status === AudioPlayerStatus.Playing || state?.status === AudioPlayerStatus.Paused) {
            const resource = (state as AudioPlayerPlayingState | AudioPlayerPausedState).resource;
            if (resource?.volume) {
                resource.volume.setVolume(clamped / 100);
                applied = true;
            }
        }

        if (!applied && state?.status === AudioPlayerStatus.Playing && queue.currentTrack) {
            const offset = this.getCurrentTime(guildId);
            void this.resumeCurrentTrack(queue, offset).catch((error) => {
                log.warn('Impossible de recreer la ressource audio pour appliquer le volume', error);
            });
        }

        log.debug(`Volume ${applied ? 'applique' : 'memorise'}: ${clamped}%`);
        return true;
    }

    /**
     * Gere la fin d'une piste
     */
    private handleTrackEnd(queue: GuildQueue): void {
        const currentTrackId = queue.currentTrack?.id ?? null;
        const now = Date.now();
        if (!queue.currentTrack && !queue.crossfadeInProgress) {
            log.trace('Fin de piste ignoree (aucune piste active)');
            return;
        }

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
            const activeTrackId = this.getActiveResourceTrackId(queue.guildId);
            if (activeTrackId !== queue.crossfadeTargetTrackId) {
                log.debug('Fin de piste ignorée (crossfade en cours, piste source)');
                return;
            }

            const interruptedTrack = queue.currentTrack;
            log.warn('Crossfade interrompu avant stabilisation, reprise standard', {
                currentTrack: interruptedTrack?.title ?? null,
                playbackDuration: this.activeResources.get(queue.guildId)?.playbackDuration ?? null,
            });

            this.lastTrackEndEvent.set(queue.guildId, {
                trackId: currentTrackId ? `${currentTrackId}:crossfade-failure` : null,
                at: now,
            });

            this.teardownActiveResource(queue.guildId);
            this.stopCrossfadeMonitor(queue.guildId);
            queue.crossfadeInProgress = false;
            queue.crossfadeTargetTrackId = null;
            queue.isPlaying = false;
            queue.isPaused = false;
            queue.autoPausedByEmptyChannel = false;
            queue.startedAt = null;
            queue.pausedAt = null;
            queue.totalPausedTime = 0;

            if (interruptedTrack) {
                queue.tracks.unshift(interruptedTrack);
            }

            void this.playNext(queue.guildId);
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
        this.stopCrossfadeMonitor(queue.guildId);
        queue.isPlaying = false;
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
        queue.crossfadeTargetTrackId = null;
        queue.startedAt = null;
        queue.pausedAt = null;
        queue.totalPausedTime = 0;
        const previousTrack = queue.currentTrack;
        queue.currentTrack = null;

        if (previousTrack) {
            log.info(`Piste terminee: ${previousTrack.title}`);
            audioWrapper.clearFromCache(queue.guildId, previousTrack.id);
            this.clearLyrics(queue, previousTrack.id);
            void this.pruneCache();
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

        const currentTime = this.getCurrentTime(guildId);
        const paused = queue.player.pause();
        if (!paused) {
            log.trace('Pause refusee par le player');
            return false;
        }

        queue.startedAt = Date.now() - currentTime * 1000;
        queue.totalPausedTime = 0;
        queue.pausedAt = Date.now();
        queue.isPaused = true;
        queue.autoPausedByEmptyChannel = false;
        this.stopCrossfadeMonitor(guildId);
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

        if (!queue.startedAt) {
            const currentTime = this.getCurrentTime(guildId);
            queue.startedAt = Date.now() - currentTime * 1000;
            queue.totalPausedTime = 0;
        }

        queue.player.unpause();
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
        this.startCrossfadeMonitor(queue);
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

            const settings = await guildSettingsManager.getSettings(guildId);
            const resource = await audioWrapper.createResource(
                guildId,
                queue.currentTrack,
                clamped,
                settings.sponsorBlockEnabled,
                queue.volume
            );
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
            await this.replaceActiveResource(queue, resource);
            this.startCrossfadeMonitor(queue);
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
        queue.isManualDisconnect = true;
        queue.shouldKeepConnection = false;
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
        this.stopCrossfadeMonitor(guildId);
        void audioWrapper.cleanupGuildTemp(guildId);

        if (queue.player) {
            queue.player.stop(true);
        }

        this.clearLyrics(queue);
        void this.pruneCache();
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
        this.stopCrossfadeMonitor(guildId);
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
        void this.pruneCache();
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
        void this.pruneCache();
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
        void this.pruneCache();
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
        if (!queue) return 0;

        if (queue.startedAt) {
            const now = queue.isPaused && queue.pausedAt ? queue.pausedAt : Date.now();
            return Math.max(0, Math.floor((now - queue.startedAt - queue.totalPausedTime) / 1000));
        }

        const resource = this.activeResources.get(guildId);
        if (!resource || !queue.currentTrack) {
            return 0;
        }

        const metadata = resource.metadata as { startSeconds?: number } | undefined;
        const baseSeconds = Number.isFinite(metadata?.startSeconds) ? metadata?.startSeconds ?? 0 : 0;
        const fallbackSeconds = Math.max(0, Math.floor(baseSeconds + resource.playbackDuration / 1000));
        if (Number.isFinite(queue.currentTrack.duration) && queue.currentTrack.duration > 0) {
            return Math.min(fallbackSeconds, queue.currentTrack.duration);
        }

        return fallbackSeconds;
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

    private getActiveTrackIds(): Set<string> {
        const ids = new Set<string>();
        for (const queue of this.queues.values()) {
            if (queue.currentTrack) {
                ids.add(queue.currentTrack.id);
            }
            for (const track of queue.tracks) {
                ids.add(track.id);
            }
        }
        return ids;
    }

    private async pruneCache(): Promise<void> {
        await mediaCacheManager.clearUnused(this.getActiveTrackIds());
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

        this.rememberRetiredResource(guildId, resource);
        audioWrapper.teardownResource(resource);
        this.activeResources.delete(guildId);
    }

    private async replaceActiveResource(queue: GuildQueue, resource: AudioResource): Promise<void> {
        if (!queue.player) {
            throw new Error('Player non disponible');
        }

        this.resourceSwapInProgress.add(queue.guildId);
        try {
            this.teardownActiveResource(queue.guildId);
            await this.waitForPipelineSettle();
            this.activeResources.set(queue.guildId, resource);
            queue.player.play(resource);
        } finally {
            this.resourceSwapInProgress.delete(queue.guildId);
        }
    }

    private getActiveResourceTrackId(guildId: string): string | null {
        const resource = this.activeResources.get(guildId);
        if (!resource) {
            return null;
        }

        const metadata = resource.metadata as { trackId?: string } | undefined;
        return metadata?.trackId ?? null;
    }

    private getResourceIdentity(
        guildId: string,
        resourceLike: AudioResource | { metadata?: { trackId?: string; createdAt?: number } } | null | undefined
    ): string | null {
        const metadata = resourceLike?.metadata as { trackId?: string; createdAt?: number } | undefined;
        if (!metadata?.trackId || !metadata?.createdAt) {
            return null;
        }

        return `${guildId}:${metadata.trackId}:${metadata.createdAt}`;
    }

    private rememberRetiredResource(guildId: string, resource: AudioResource): void {
        const key = this.getResourceIdentity(guildId, resource);
        if (!key) {
            return;
        }

        const previousTimer = this.retiredResources.get(key);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const cleanupTimer = setTimeout(() => {
            this.retiredResources.delete(key);
        }, this.retiredResourceRetentionMs);
        cleanupTimer.unref();
        this.retiredResources.set(key, cleanupTimer);
    }

    private shouldIgnorePlayerResourceError(
        guildId: string,
        resourceLike: AudioResource | { metadata?: { trackId?: string; createdAt?: number } } | null | undefined
    ): boolean {
        const key = this.getResourceIdentity(guildId, resourceLike);
        if (!key) {
            return false;
        }

        return this.retiredResources.has(key);
    }

    private clearRetiredResources(guildId: string): void {
        for (const [key, timer] of this.retiredResources.entries()) {
            if (!key.startsWith(`${guildId}:`)) {
                continue;
            }

            clearTimeout(timer);
            this.retiredResources.delete(key);
        }
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
        const cacheCandidates = queue.tracks.slice(1, config.audio.cacheAhead + 1);
        void audioWrapper.preloadTracks(queue.guildId, cacheCandidates);
        void audioWrapper.warmTrack(queue.guildId, nextTrack);
    }

    private startCrossfadeMonitor(queue: GuildQueue): void {
        this.stopCrossfadeMonitor(queue.guildId);
        if (!queue.currentTrack || queue.tracks.length === 0 || queue.isPaused || !queue.isPlaying) {
            return;
        }

        const remainingMs = (
            queue.currentTrack.duration -
            this.getCurrentTime(queue.guildId) -
            this.crossfadeSeconds -
            this.crossfadePrepareLeadSeconds
        ) * 1000;
        const delayMs = Number.isFinite(remainingMs) ? Math.max(250, remainingMs) : 250;
        const timer = setTimeout(() => {
            void this.maybeTriggerCrossfade(queue.guildId);
        }, delayMs);

        this.crossfadeMonitors.set(queue.guildId, timer);
    }

    private stopCrossfadeMonitor(guildId: string): void {
        const monitor = this.crossfadeMonitors.get(guildId);
        if (!monitor) {
            return;
        }

        clearTimeout(monitor);
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
        if (remaining > this.crossfadeSeconds + this.crossfadePrepareLeadSeconds + 0.25 || remaining <= 0) {
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
            queue.currentTrack = nextTrack;
            queue.startedAt = Date.now();
            queue.pausedAt = null;
            queue.totalPausedTime = 0;
            queue.isPaused = false;
            queue.isPlaying = true;
            queue.autoPausedByEmptyChannel = false;

            audioWrapper.clearFromCache(guildId, currentTrack.id);
            this.clearLyrics(queue, currentTrack.id);
            void this.pruneCache();
            this.emit('trackEnd', queue, currentTrack);

            await this.replaceActiveResource(queue, resource);
            setTimeout(() => {
                const latestQueue = this.queues.get(guildId);
                if (!latestQueue) {
                    return;
                }
                if (latestQueue.crossfadeTargetTrackId === nextTrack.id) {
                    latestQueue.crossfadeInProgress = false;
                    latestQueue.crossfadeTargetTrackId = null;
                }
            }, (this.crossfadeSeconds + this.crossfadePrepareLeadSeconds) * 1000 + 250);
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

        clearTimeout(monitor);
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
        const markedConnections = this.intentionalConnectionDestroy.get(guildId) ?? new Set<VoiceConnection>();
        markedConnections.add(connection);
        this.intentionalConnectionDestroy.set(guildId, markedConnections);
    }

    private consumeIntentionalConnectionDestroy(guildId: string, connection: VoiceConnection): boolean {
        const markedConnections = this.intentionalConnectionDestroy.get(guildId);
        if (!markedConnections?.has(connection)) {
            return false;
        }

        markedConnections.delete(connection);
        if (markedConnections.size === 0) {
            this.intentionalConnectionDestroy.delete(guildId);
        }
        return true;
    }
}

export const queueManager = new QueueManager();
