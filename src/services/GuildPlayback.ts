import type { AudioResource, VoiceConnection } from '@discordjs/voice';
import type { GuildQueue, PauseReason, PlaybackStatus, Track } from '../types/index.js';

/**
 * Machine à états de lecture d'une guilde.
 *
 *   idle ──▶ starting ──▶ playing ◀──▶ paused
 *     ▲         │            │           │
 *     └─────────┴────────────┴───────────┘      (fin de piste, échec, annulation)
 *   n'importe quel état ──▶ stopping ──▶ idle | starting
 *
 * La reconnexion vocale est volontairement un axe séparé (`queue.isReconnecting`) :
 * une piste en pause reste en pause pendant que la connexion se rétablit.
 */
const ALLOWED_TRANSITIONS: Record<PlaybackStatus, readonly PlaybackStatus[]> = {
    idle: ['starting', 'stopping'],
    starting: ['playing', 'idle', 'stopping'],
    playing: ['paused', 'idle', 'stopping'],
    paused: ['playing', 'idle', 'stopping'],
    stopping: ['idle', 'starting'],
};

export function canTransition(from: PlaybackStatus, to: PlaybackStatus): boolean {
    return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export interface PlaybackTransition {
    previous: PlaybackStatus;
    /** `false` quand la transition n'est pas prévue par la table : elle est appliquée, mais doit être signalée. */
    expected: boolean;
}

/**
 * Applique une transition. Une transition imprévue n'est jamais refusée : les
 * événements du player Discord font foi, on préfère un état cohérent avec eux
 * et un avertissement dans les logs plutôt qu'une lecture bloquée.
 */
export function applyPlaybackTransition(
    queue: Pick<GuildQueue, 'playback' | 'pauseReason'>,
    next: PlaybackStatus,
    pauseReason: PauseReason = 'user'
): PlaybackTransition {
    const previous = queue.playback;
    queue.playback = next;
    if (next !== 'paused') {
        queue.pauseReason = null;
    } else if (previous !== 'paused' || !queue.pauseReason) {
        queue.pauseReason = pauseReason;
    }
    return { previous, expected: canTransition(previous, next) };
}

/** Une piste est chargée dans le player (en lecture ou en pause). */
export function isPlaybackActive(queue: Pick<GuildQueue, 'playback'>): boolean {
    return queue.playback === 'playing' || queue.playback === 'paused';
}

/**
 * Vrai si un appelant peut lancer `playNext`. Faux pendant `starting` : un
 * démarrage est déjà en vol et prendra la piste suivante de la file lui-même.
 */
export function canBeginPlayback(queue: Pick<GuildQueue, 'playback' | 'currentTrack'>): boolean {
    return !queue.currentTrack && (queue.playback === 'idle' || queue.playback === 'stopping');
}

export interface PendingPlaybackStart {
    queue: GuildQueue;
    track: Track;
    resource: AudioResource;
}

/**
 * État d'exécution d'une guilde : tout ce qui n'est pas la file elle-même
 * (timers, ressource active, verrous, jetons d'annulation).
 * Il survit à la suppression de la queue pour que `transitionNonce` reste
 * monotone : une opération en vol d'une ancienne queue ne peut pas se croire
 * à jour sur la suivante.
 */
export interface GuildRuntime {
    activeResource: AudioResource | null;
    /** Ressource remise au player, en attente de l'événement Playing. */
    pendingStart: PendingPlaybackStart | null;
    /** Piste que le démarrage en vol est en train de préparer (état `starting`). */
    startingTrack: Track | null;
    /** Ressources retirées récemment : leurs événements tardifs sont ignorés. */
    retiredResources: Map<string, NodeJS.Timeout>;
    warmedTrackId: string | null;
    /** Piste suivante dont le fondu est en préparation ou attaché au mixeur. */
    crossfadeNext: Track | null;
    /** Piste arrivée par fondu : si son flux s'arrête trop tôt, elle est reprise une fois. */
    crossfadedTrack: Track | null;
    lastTrackEnd: { trackId: string | null; at: number } | null;

    transitionNonce: number;
    transitionLock: Promise<void> | null;
    sessionAbort: AbortController | null;

    voiceChannelMonitor: NodeJS.Timeout | null;
    bufferingWatchdog: NodeJS.Timeout | null;

    connectionAttempt: Promise<VoiceConnection | null> | null;
    reconnectAttempt: { promise: Promise<boolean>; signal: AbortSignal } | null;
    intentionalConnectionDestroy: Set<VoiceConnection>;
}

export function createGuildRuntime(): GuildRuntime {
    return {
        activeResource: null,
        pendingStart: null,
        startingTrack: null,
        retiredResources: new Map(),
        warmedTrackId: null,
        crossfadeNext: null,
        crossfadedTrack: null,
        lastTrackEnd: null,
        transitionNonce: 0,
        transitionLock: null,
        sessionAbort: null,
        voiceChannelMonitor: null,
        bufferingWatchdog: null,
        connectionAttempt: null,
        reconnectAttempt: null,
        intentionalConnectionDestroy: new Set(),
    };
}
