import {
    joinVoiceChannel,
    createAudioPlayer,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    VoiceConnection,
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
import { runtimeTelemetry } from './RuntimeTelemetry.js';

const log = logger.createModuleLogger('QueueManager');

export type PlaybackStartFailureCode =
    | 'queue_missing'
    | 'voice_join_failed'
    | 'resource_failed'
    | 'player_unavailable'
    | 'start_timeout'
    | 'cancelled';

export type PlaybackStartResult =
    | { status: 'started'; track: Track }
    | { status: 'queue_empty' }
    | {
        status: 'failed';
        code: PlaybackStartFailureCode;
        retryable: boolean;
        track?: Track;
    };

type PlaybackRecoveryContext = {
    signal: AbortSignal;
    transitionNonce: number;
    track: Track | null;
};

class QueueManager extends EventEmitter {
    private queues: Map<string, GuildQueue> = new Map();
    private voiceChannelMonitors: Map<string, NodeJS.Timeout> = new Map();
    private intentionalConnectionDestroy: Map<string, Set<VoiceConnection>> = new Map();
    private activeResources: Map<string, AudioResource> = new Map();
    private pendingPlaybackStarts: Map<string, { queue: GuildQueue; track: Track; resource: AudioResource }> = new Map();
    private retiredResources: Map<string, NodeJS.Timeout> = new Map();
    private transitionNonces: Map<string, number> = new Map();
    private sessionAbortControllers: Map<string, AbortController> = new Map();
    private bufferingWatchdogs: Map<string, NodeJS.Timeout> = new Map();
    private warmedTrackByGuild: Map<string, string> = new Map();
    private lastTrackEndEvent: Map<string, { trackId: string | null; at: number }> = new Map();
    private transitionLocks: Map<string, Promise<void>> = new Map();
    private connectionAttempts: Map<string, Promise<VoiceConnection | null>> = new Map();
    private reconnectAttemptsInFlight: Map<
        string,
        { promise: Promise<boolean>; signal: AbortSignal }
    > = new Map();
    private readonly playbackStartTimeoutMs = 15_000;
    private readonly bufferingTimeoutMs = 10_000;
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
            lastStartMetrics: null,
        };

        this.beginQueueSession(guildId);
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
        this.clearBufferingWatchdog(guildId);
        this.invalidateQueueSession(guildId);
        if (queue) {
            queue.isManualDisconnect = manualDisconnect;
            queue.isReconnecting = false;
            queue.reconnectAttempts = 0;
            this.teardownActiveResource(guildId);
            this.pendingPlaybackStarts.delete(guildId);
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
            this.clearLyrics(queue);
            this.queues.delete(guildId);
            this.emit('queueDeleted', guildId, queue);
            log.info(`Queue supprimée pour guild: ${guildId}`);
            this.intentionalConnectionDestroy.delete(guildId);
            this.lastTrackEndEvent.delete(guildId);
            this.transitionLocks.delete(guildId);
            this.connectionAttempts.delete(guildId);
            this.reconnectAttemptsInFlight.delete(guildId);
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

        const maxAttempts = queue.isReconnecting ? 1 : 3;
        const readyTimeoutMs = queue.isReconnecting ? 5_000 : 10_000;
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

                if (this.queues.get(queue.guildId) !== queue || queue.isManualDisconnect) {
                    this.destroyConnection(queue.guildId, connection);
                    if (queue.connection === connection) {
                        queue.connection = null;
                    }
                    return null;
                }

                if (queue.player) {
                    const subscription = connection.subscribe(queue.player);
                    if (subscription) {
                        log.debug('Subscription créée avec succès');
                    } else {
                        throw new Error('Échec de la création de la subscription audio');
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
                const reconnect = this.reconnectWithBackoff(queue, resumeOffset);
                const reconnectSignal = this.reconnectAttemptsInFlight.get(guildId)?.signal;
                void reconnect.then((reconnected) => {
                    if (
                        !reconnected &&
                        reconnectSignal &&
                        !reconnectSignal.aborted &&
                        !queue.isManualDisconnect &&
                        this.queues.get(guildId) === queue
                    ) {
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

        player.on(AudioPlayerStatus.Idle, (oldState: AudioPlayerState) => {
            this.clearBufferingWatchdog(queue.guildId);
            const retiredResource = 'resource' in oldState ? oldState.resource : null;
            const activeResource = this.activeResources.get(queue.guildId);
            if (
                retiredResource &&
                (this.shouldIgnorePlayerResourceError(queue.guildId, retiredResource) ||
                    (activeResource && retiredResource !== activeResource))
            ) {
                log.trace('Player idle ignoré (ancienne ressource)');
                return;
            }
            log.debug('Player passé en Idle');
            this.handleTrackEnd(queue);
        });

        player.on(AudioPlayerStatus.Playing, (_oldState: AudioPlayerState, newState: AudioPlayerPlayingState) => {
            this.clearBufferingWatchdog(queue.guildId);
            if (this.activeResources.get(queue.guildId) !== newState.resource) {
                log.trace('Événement Playing ignoré pour une ancienne ressource');
                return;
            }
            if (!this.promotePendingStart(queue, newState.resource)) {
                const pending = this.pendingPlaybackStarts.get(queue.guildId);
                if (pending?.resource === newState.resource) {
                    log.trace('Événement Playing ignoré pour une ressource obsolète');
                    return;
                }
            }
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
            this.startBufferingWatchdog(queue);
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
            const recovery = this.captureRecoveryContext(activeQueue);
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 900);
                if (!this.isRecoveryCurrent(activeQueue, recovery)) {
                    log.trace('Récupération Discord ignorée: session remplacée');
                    return;
                }
                if (activeQueue.connection === connection && activeQueue.player) {
                    if (!connection.subscribe(activeQueue.player)) {
                        throw new Error('Subscription audio impossible après récupération Discord');
                    }
                }
                log.info('Connexion vocale récupérée par Discord');
            } catch (error) {
                if (!this.isRecoveryCurrent(activeQueue, recovery)) {
                    log.trace('Échec de récupération Discord ignoré: session remplacée');
                    return;
                }
                log.warn('Récupération simple échouée, tentative de reconnexion complète', error);
                const reconnect = this.reconnectWithBackoff(activeQueue, resumeOffset);
                const reconnectSignal = this.reconnectAttemptsInFlight.get(queue.guildId)?.signal;
                const reconnected = await reconnect;
                if (
                    !reconnected &&
                    reconnectSignal &&
                    !reconnectSignal.aborted &&
                    !activeQueue.isManualDisconnect &&
                    this.queues.get(queue.guildId) === activeQueue
                ) {
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
            const reconnect = this.reconnectWithBackoff(
                activeQueue,
                activeQueue.currentTrack ? this.getCurrentTime(queue.guildId) : 0
            );
            const reconnectSignal = this.reconnectAttemptsInFlight.get(queue.guildId)?.signal;
            void reconnect
                .then((reconnected) => {
                    if (
                        !reconnected &&
                        reconnectSignal &&
                        !reconnectSignal.aborted &&
                        !activeQueue.isManualDisconnect &&
                        this.queues.get(queue.guildId) === activeQueue
                    ) {
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
        const existing = this.reconnectAttemptsInFlight.get(queue.guildId);
        if (existing && !existing.signal.aborted) {
            return existing.promise;
        }

        const signal = this.beginQueueSession(queue.guildId);
        const recovery: PlaybackRecoveryContext = {
            signal,
            transitionNonce: this.transitionNonces.get(queue.guildId) ?? 0,
            track: queue.currentTrack,
        };
        const attempt = this.reconnectWithBackoffInternal(queue, resumeOffset, recovery);
        this.reconnectAttemptsInFlight.set(queue.guildId, { promise: attempt, signal });
        try {
            return await attempt;
        } finally {
            if (this.reconnectAttemptsInFlight.get(queue.guildId)?.promise === attempt) {
                queue.isReconnecting = false;
                queue.reconnectAttempts = 0;
                this.reconnectAttemptsInFlight.delete(queue.guildId);
            }
        }
    }

    private async reconnectWithBackoffInternal(
        queue: GuildQueue,
        resumeOffset: number,
        recovery: PlaybackRecoveryContext
    ): Promise<boolean> {
        if (!this.isRecoveryCurrent(queue, recovery)) {
            return false;
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
                    const baseDelayMs = Math.min(
                        config.audio.voiceReconnectMaxDelayMs,
                        config.audio.voiceReconnectBaseDelayMs * 2 ** (attempt - 2)
                    );
                    const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs * 0.25)));
                    const delayMs = Math.min(config.audio.voiceReconnectMaxDelayMs, baseDelayMs + jitterMs);
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }

                if (!this.isRecoveryCurrent(queue, recovery)) {
                    return false;
                }

                queue.reconnectAttempts = attempt;
                runtimeTelemetry.recordReconnectAttempt();
                const connection = await this.joinChannel(queue);
                if (!connection) {
                    log.warn(`Tentative de reconnexion échouée (#${attempt}/${config.audio.voiceReconnectMaxAttempts})`);
                    continue;
                }

                if (!this.isRecoveryCurrent(queue, recovery)) {
                    log.trace('Connexion récupérée mais session remplacée, reprise abandonnée');
                    return false;
                }

                queue.isReconnecting = false;
                queue.reconnectAttempts = 0;

                if (queue.currentTrack && this.reattachActivePlayback(queue, resumeOffset, recovery)) {
                    return true;
                }
                if (queue.currentTrack) {
                    return this.resumeCurrentTrack(queue, resumeOffset, recovery);
                }
                if (queue.tracks.length > 0) {
                    return (await this.playNext(queue.guildId)).status === 'started';
                }
                return true;
            }
        } finally {
            if (this.isRecoveryCurrent(queue, recovery)) {
                queue.isReconnecting = false;
            }
        }

        return false;
    }

    private async resumeCurrentTrack(
        queue: GuildQueue,
        resumeOffset: number,
        recovery: PlaybackRecoveryContext = this.captureRecoveryContext(queue)
    ): Promise<boolean> {
        const expectedTrack = recovery.track;
        if (!expectedTrack || !queue.player || !this.isRecoveryCurrent(queue, recovery)) {
            return false;
        }

        const settings = await guildSettingsManager.getSettings(queue.guildId);
        if (!this.isRecoveryCurrent(queue, recovery)) {
            return false;
        }
        const resource = await audioWrapper.createResource(
            queue.guildId,
            expectedTrack,
            Math.max(0, resumeOffset),
            settings.sponsorBlockEnabled,
            queue.volume
        );
        if (!resource) {
            return false;
        }

        if (!this.isRecoveryCurrent(queue, recovery)) {
            log.trace('Ressource de reprise obsolète détruite avant installation', {
                guildId: queue.guildId,
                track: expectedTrack.title,
            });
            audioWrapper.teardownResource(resource);
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
        const started = await this.waitForPlaybackStart(queue, resource, recovery.signal);
        if (!started && this.activeResources.get(queue.guildId) === resource) {
            this.teardownActiveResource(queue.guildId);
        }
        return started && this.isRecoveryCurrent(queue, recovery);
    }

    private reattachActivePlayback(
        queue: GuildQueue,
        resumeOffset: number,
        recovery: PlaybackRecoveryContext
    ): boolean {
        if (!this.isRecoveryCurrent(queue, recovery)) {
            return false;
        }
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

        if (!this.isRecoveryCurrent(queue, recovery)) {
            return false;
        }

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
    async playNext(guildId: string): Promise<PlaybackStartResult> {
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

    private async playNextInternal(guildId: string): Promise<PlaybackStartResult> {
        const requestStartedAt = Date.now();
        log.debug(`playNext appele pour guild: ${guildId}`);
        const queue = this.queues.get(guildId);
        if (!queue) {
            log.warn('Queue non trouvee');
            return { status: 'failed', code: 'queue_missing', retryable: false };
        }
        const transitionNonce = this.bumpTransitionNonce(guildId);
        const sessionSignal = this.getQueueSessionSignal(guildId);

        if (queue.tracks.length === 0) {
            log.info('File d\'attente vide');
            queue.currentTrack = null;
            queue.isPlaying = false;
            queue.shouldKeepConnection = false;
            queue.autoPausedByEmptyChannel = false;
            this.clearLyrics(queue);
            this.clearGuildWarmup(guildId);
            void audioWrapper.cleanupGuildTemp(guildId);
            this.emit('queueEmpty', queue);

            const settings = await guildSettingsManager.getSettings(guildId);
            if (!settings.stayConnected && !settings.stayConnectedAlways) {
                log.info('Déconnexion (queue vide, stay-connected désactivé)');
                this.deleteQueue(guildId, false);
            }

            return { status: 'queue_empty' };
        }

        if (queue.currentTrack) {
            this.clearLyrics(queue, queue.currentTrack.id);
        }

        const track = queue.tracks[0]!;

        log.info(`Prochaine piste: ${track.title}`);
        log.trace('Details:', track);

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
        const settings = await guildSettingsManager.getSettings(guildId);
        const resourcePromise = audioWrapper.createResource(
            guildId,
            track,
            0,
            settings.sponsorBlockEnabled,
            settings.volume
        );

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
            return { status: 'failed', code: 'voice_join_failed', retryable: true, track };
        }

        this.attachWarmupMetrics(guildId, track, warmHit, warmupPromise);

        if (
            sessionSignal.aborted ||
            this.queues.get(guildId) !== queue ||
            !this.isTransitionCurrent(guildId, transitionNonce)
        ) {
            log.debug(`Transition obsolete ignoree pour ${guildId}`);
            if (resource) {
                audioWrapper.teardownResource(resource);
            }
            return { status: 'failed', code: 'cancelled', retryable: true, track };
        }

        if (!resource) {
            log.warn(`Première résolution audio échouée, nouvelle tentative: ${track.title}`);
            audioWrapper.clearFromCache(guildId, track.id);
            resource = await audioWrapper.createResource(
                guildId,
                track,
                0,
                settings.sponsorBlockEnabled,
                settings.volume
            );
        }

        const volume = Math.max(0, Math.min(200, settings.volume));
        queue.volume = volume;

        if (!queue.player) {
            log.error('Player non disponible!');
            audioWrapper.teardownResource(resource);
            return { status: 'failed', code: 'player_unavailable', retryable: true, track };
        }

        if (!resource) {
            log.error(`Impossible de creer la ressource pour: ${track.title}`);
            queue.tracks.shift();
            this.emit('trackFailed', queue, track, 'resource_failed');
            if (queue.tracks.length > 0) {
                await this.playNextInternal(guildId);
                return { status: 'failed', code: 'resource_failed', retryable: true, track };
            }
            await this.playNextInternal(guildId);
            return { status: 'failed', code: 'resource_failed', retryable: true, track };
        }

        const started = await this.startTrackResource(
            queue,
            track,
            resource,
            volume,
            transitionNonce,
            sessionSignal
        );
        if (
            sessionSignal.aborted ||
            this.queues.get(guildId) !== queue ||
            !this.isTransitionCurrent(guildId, transitionNonce)
        ) {
            return { status: 'failed', code: 'cancelled', retryable: true, track };
        }

        if (!started && this.isTransitionCurrent(guildId, transitionNonce) && !sessionSignal.aborted) {
            log.warn(`Lecture non confirmée, seconde ressource: ${track.title}`);
            runtimeTelemetry.recordPlaybackRetry();
            audioWrapper.clearFromCache(guildId, track.id);
            const retryResource = await audioWrapper.createResource(
                guildId,
                track,
                0,
                settings.sponsorBlockEnabled,
                settings.volume
            );
            if (retryResource) {
                const retryStarted = await this.startTrackResource(
                    queue,
                    track,
                    retryResource,
                    volume,
                    transitionNonce,
                    sessionSignal
                );
                if (retryStarted) {
                    this.refreshWarmup(queue);
                    log.debug(`request_to_play_ms=${Date.now() - requestStartedAt} (guild: ${guildId}, retry=true)`);
                    runtimeTelemetry.recordPlaybackStart(Date.now() - requestStartedAt, joinMs, resourceMs);
                    return { status: 'started', track };
                }
            }
        }

        if (!started) {
            if (
                sessionSignal.aborted ||
                this.queues.get(guildId) !== queue ||
                !this.isTransitionCurrent(guildId, transitionNonce)
            ) {
                return { status: 'failed', code: 'cancelled', retryable: true, track };
            }
            if (this.queues.get(guildId) === queue && queue.currentTrack === track) {
                queue.currentTrack = null;
            }
            const trackIndex = queue.tracks.findIndex((candidate) => candidate === track || candidate.id === track.id);
            if (trackIndex >= 0) {
                queue.tracks.splice(trackIndex, 1);
            }
            this.emit('trackFailed', queue, track, 'start_timeout');
            if (queue.tracks.length > 0 && !sessionSignal.aborted) {
                await this.playNextInternal(guildId);
                return { status: 'failed', code: 'start_timeout', retryable: true, track };
            }
            await this.playNextInternal(guildId);
            return { status: 'failed', code: 'start_timeout', retryable: true, track };
        }

        this.refreshWarmup(queue);
        log.debug(`request_to_play_ms=${Date.now() - requestStartedAt} (guild: ${guildId})`);
        runtimeTelemetry.recordPlaybackStart(Date.now() - requestStartedAt, joinMs, resourceMs);

        return { status: 'started', track };
    }

    private async startTrackResource(
        queue: GuildQueue,
        track: Track,
        resource: AudioResource,
        volume: number,
        transitionNonce: number,
        sessionSignal: AbortSignal
    ): Promise<boolean> {
        if (
            sessionSignal.aborted ||
            this.queues.get(queue.guildId) !== queue ||
            !this.isTransitionCurrent(queue.guildId, transitionNonce) ||
            !queue.player
        ) {
            audioWrapper.teardownResource(resource);
            return false;
        }

        if (resource.volume) {
            resource.volume.setVolume(volume / 100);
        }

        queue.totalPausedTime = 0;
        queue.isStopping = false;
        queue.isManualDisconnect = false;
        queue.shouldKeepConnection = true;
        queue.autoPausedByEmptyChannel = false;
        queue.startedAt = null;
        queue.pausedAt = null;

        this.pendingPlaybackStarts.set(queue.guildId, { queue, track, resource });
        await this.replaceActiveResource(queue, resource);
        const started = await this.waitForPlaybackStart(queue, resource, sessionSignal);
        if (started) {
            return this.promotePendingStart(queue, resource) || queue.currentTrack === track;
        }

        const pending = this.pendingPlaybackStarts.get(queue.guildId);
        if (pending?.resource === resource) {
            this.pendingPlaybackStarts.delete(queue.guildId);
        }
        if (this.queues.get(queue.guildId) === queue && queue.currentTrack === track) {
            queue.isPlaying = false;
            queue.isPaused = false;
            queue.startedAt = null;
            queue.pausedAt = null;
        }
        if (this.activeResources.get(queue.guildId) === resource) {
            this.teardownActiveResource(queue.guildId);
        }
        return false;
    }

    private async waitForPlaybackStart(
        queue: GuildQueue,
        resource: AudioResource,
        sessionSignal: AbortSignal = this.getQueueSessionSignal(queue.guildId)
    ): Promise<boolean> {
        if (!queue.player || sessionSignal.aborted) {
            return false;
        }

        const startController = new AbortController();
        const abortHandler = () => startController.abort();
        const timeout = setTimeout(() => startController.abort(), this.playbackStartTimeoutMs);
        timeout.unref?.();
        sessionSignal.addEventListener('abort', abortHandler, { once: true });
        try {
            if (sessionSignal.aborted) {
                startController.abort();
            }
            await entersState(queue.player, AudioPlayerStatus.Playing, startController.signal);
            return (
                !sessionSignal.aborted &&
                this.queues.get(queue.guildId) === queue &&
                this.activeResources.get(queue.guildId) === resource &&
                queue.player.state.status === AudioPlayerStatus.Playing
            );
        } catch (error) {
            log.warn(`Démarrage audio non confirmé après ${this.playbackStartTimeoutMs}ms`, {
                guildId: queue.guildId,
                track: queue.currentTrack?.title ?? null,
                message: (error as Error)?.message ?? String(error),
            });
            return false;
        } finally {
            clearTimeout(timeout);
            sessionSignal.removeEventListener('abort', abortHandler);
        }
    }

    private promotePendingStart(queue: GuildQueue, resource: AudioResource): boolean {
        const pending = this.pendingPlaybackStarts.get(queue.guildId);
        if (!pending) {
            return false;
        }
        if (
            pending.queue !== queue ||
            pending.resource !== resource ||
            this.activeResources.get(queue.guildId) !== resource ||
            this.queues.get(queue.guildId) !== queue ||
            queue.player?.state.status !== AudioPlayerStatus.Playing
        ) {
            return false;
        }

        const queuedIndex = queue.tracks.findIndex(
            (candidate) => candidate === pending.track || candidate.id === pending.track.id
        );
        if (queuedIndex >= 0) {
            queue.tracks.splice(queuedIndex, 1);
        }
        queue.currentTrack = pending.track;
        this.pendingPlaybackStarts.delete(queue.guildId);
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
                    await entersState(queue.connection, VoiceConnectionStatus.Ready, 10_000);
                    if (queue.player && !queue.connection.subscribe(queue.player)) {
                        throw new Error('Subscription audio impossible après déplacement');
                    }
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
        if (!queue.currentTrack) {
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
        this.clearBufferingWatchdog(queue.guildId);
        queue.isPlaying = false;
        queue.isPaused = false;
        queue.autoPausedByEmptyChannel = false;
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
        log.info('Lecture reprise');
        return true;
    }

    /**
     * Avance ou recule la lecture vers un temps cible
     */
    async seekTo(guildId: string, targetSeconds: number): Promise<boolean> {
        return this.runWithTransitionLock(guildId, async () => {
            const queue = this.queues.get(guildId);
            if (
                !queue ||
                !queue.player ||
                !queue.currentTrack ||
                queue.isReconnecting ||
                !queue.connection ||
                queue.connection.state.status !== VoiceConnectionStatus.Ready
            ) {
                log.warn(`Seek impossible pour guild: ${guildId}`);
                return false;
            }

            const expectedTrack = queue.currentTrack;
            const recovery: PlaybackRecoveryContext = {
                signal: this.getQueueSessionSignal(guildId),
                transitionNonce: this.bumpTransitionNonce(guildId),
                track: expectedTrack,
            };

            const duration = expectedTrack.duration;
            const clamped = duration > 0
                ? Math.max(0, Math.min(Math.floor(targetSeconds), duration - 1))
                : Math.max(0, Math.floor(targetSeconds));

            log.info(`Seek vers ${clamped}s (piste: ${expectedTrack.title})`);

            const settings = await guildSettingsManager.getSettings(guildId);
            if (!this.isRecoveryCurrent(queue, recovery)) {
                return false;
            }
            const resource = await audioWrapper.createResource(
                guildId,
                expectedTrack,
                clamped,
                settings.sponsorBlockEnabled,
                queue.volume
            );
            if (!resource) {
                log.error('Seek: impossible de créer la ressource audio');
                return false;
            }

            if (!this.isRecoveryCurrent(queue, recovery)) {
                audioWrapper.teardownResource(resource);
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

            await this.replaceActiveResource(queue, resource);
            const started = await this.waitForPlaybackStart(queue, resource, recovery.signal);
            if (!started && this.activeResources.get(guildId) === resource) {
                this.teardownActiveResource(guildId);
            }
            return started && this.isRecoveryCurrent(queue, recovery);
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
        queue.isReconnecting = false;
        queue.reconnectAttempts = 0;
        queue.autoPausedByEmptyChannel = false;
        queue.startedAt = null;
        queue.pausedAt = null;
        queue.totalPausedTime = 0;
        this.beginQueueSession(guildId);
        this.teardownActiveResource(guildId);
        this.clearGuildWarmup(guildId);
        this.clearBufferingWatchdog(guildId);
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

        const pending = this.pendingPlaybackStarts.get(guildId);
        const hadCurrentTrack = Boolean(queue.currentTrack);
        const skippedTrack = queue.currentTrack ?? pending?.track ?? null;
        log.info(`Skip de: ${skippedTrack?.title}`);
        queue.autoPausedByEmptyChannel = false;
        queue.isReconnecting = false;
        queue.reconnectAttempts = 0;
        this.beginQueueSession(guildId);
        if (pending) {
            this.pendingPlaybackStarts.delete(guildId);
            const pendingIndex = queue.tracks.findIndex(
                (candidate) => candidate === pending.track || candidate.id === pending.track.id
            );
            if (pendingIndex >= 0) {
                queue.tracks.splice(pendingIndex, 1);
            }
        }
        this.teardownActiveResource(guildId);
        this.clearBufferingWatchdog(guildId);
        queue.player.stop(true);
        if (!queue.currentTrack && pending) {
            void this.playNext(guildId);
        } else if (hadCurrentTrack) {
            this.handleTrackEnd(queue);
        }
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
        const pending = this.pendingPlaybackStarts.get(guildId);
        if (pending?.resource === resource) {
            this.pendingPlaybackStarts.delete(guildId);
        }
        audioWrapper.teardownResource(resource);
        this.activeResources.delete(guildId);
    }

    private async replaceActiveResource(queue: GuildQueue, resource: AudioResource): Promise<void> {
        if (!queue.player) {
            throw new Error('Player non disponible');
        }

        this.teardownActiveResource(queue.guildId);
        this.activeResources.set(queue.guildId, resource);
        queue.player.play(resource);
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
        void audioWrapper.preloadTracks(guildId, []);
        void audioWrapper.cancelGuildWarmups(guildId);
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
        const cacheCandidates = queue.tracks.slice(0, config.audio.cacheAhead);
        void audioWrapper.preloadTracks(queue.guildId, cacheCandidates);
        void audioWrapper.warmTrack(queue.guildId, nextTrack);
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

    private beginQueueSession(guildId: string): AbortSignal {
        const previous = this.sessionAbortControllers.get(guildId);
        previous?.abort();
        const controller = new AbortController();
        this.sessionAbortControllers.set(guildId, controller);
        this.bumpTransitionNonce(guildId);
        return controller.signal;
    }

    private invalidateQueueSession(guildId: string): void {
        this.sessionAbortControllers.get(guildId)?.abort();
        this.sessionAbortControllers.delete(guildId);
        this.bumpTransitionNonce(guildId);
    }

    private getQueueSessionSignal(guildId: string): AbortSignal {
        const existing = this.sessionAbortControllers.get(guildId);
        if (existing) {
            return existing.signal;
        }
        return this.beginQueueSession(guildId);
    }

    private captureRecoveryContext(queue: GuildQueue): PlaybackRecoveryContext {
        return {
            signal: this.getQueueSessionSignal(queue.guildId),
            transitionNonce: this.transitionNonces.get(queue.guildId) ?? 0,
            track: queue.currentTrack,
        };
    }

    private isRecoveryCurrent(queue: GuildQueue, recovery: PlaybackRecoveryContext): boolean {
        return (
            !recovery.signal.aborted &&
            !queue.isManualDisconnect &&
            this.queues.get(queue.guildId) === queue &&
            this.isTransitionCurrent(queue.guildId, recovery.transitionNonce) &&
            queue.currentTrack === recovery.track
        );
    }

    private startBufferingWatchdog(queue: GuildQueue): void {
        this.clearBufferingWatchdog(queue.guildId);
        const resource = this.activeResources.get(queue.guildId);
        const recovery = this.captureRecoveryContext(queue);
        const expectedTrack = recovery.track;
        if (!resource || !expectedTrack) {
            return;
        }

        const timer = setTimeout(() => {
            if (this.bufferingWatchdogs.get(queue.guildId) === timer) {
                this.bufferingWatchdogs.delete(queue.guildId);
            }
            void this.runWithTransitionLock(queue.guildId, async () => {
                const activeQueue = this.queues.get(queue.guildId);
                if (
                    activeQueue !== queue ||
                    !queue.player ||
                    queue.player.state.status !== AudioPlayerStatus.Buffering ||
                    this.activeResources.get(queue.guildId) !== resource ||
                    !this.isRecoveryCurrent(queue, recovery)
                ) {
                    return;
                }

                const resumeOffset = this.getCurrentTime(queue.guildId);
                log.warn(`Buffering bloqué depuis ${this.bufferingTimeoutMs}ms, recréation de la ressource`, {
                    guildId: queue.guildId,
                    track: expectedTrack.title,
                    resumeOffset,
                });
                const recovered = await this.resumeCurrentTrack(queue, resumeOffset, recovery);
                if (!recovered && this.isRecoveryCurrent(queue, recovery)) {
                    this.handleTrackEnd(queue);
                }
            });
        }, this.bufferingTimeoutMs);
        timer.unref();
        this.bufferingWatchdogs.set(queue.guildId, timer);
    }

    private clearBufferingWatchdog(guildId: string): void {
        const timer = this.bufferingWatchdogs.get(guildId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.bufferingWatchdogs.delete(guildId);
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
