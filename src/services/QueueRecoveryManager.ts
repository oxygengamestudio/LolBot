import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits,
    type ButtonInteraction, type Client, type Message, type StageChannel, type TextChannel, type VoiceChannel } from 'discord.js';
import { queueManager } from './QueueManager.js';
import { guildSettingsManager } from './GuildSettingsManager.js';
import { QueueRecoveryStore, RECOVERY_TTL, snapshotQueue, type QueueSnapshot } from './QueueRecoveryStore.js';
import { getFreshInteractionMember } from '../utils/commandHelpers.js';
import { canJoinVoiceChannel, canUseBot, isBotOwner } from '../utils/permissions.js';
import { logger } from '../utils/Logger.js';
import type { GuildQueue } from '../types/index.js';

const log = logger.createModuleLogger('QueueRecovery');
type Offer = { snapshot: QueueSnapshot; nonce: string; message: Message; timer: NodeJS.Timeout };

export class QueueRecoveryManager {
    private store = new QueueRecoveryStore();
    private offers = new Map<string, Offer>();
    private writes = new Map<string, Promise<void>>();
    private timers = new Map<string, NodeJS.Timeout>();
    private pending = new Map<string, QueueSnapshot | null>();
    private busy = new Set<string>();
    private restoring = new Map<string, { snapshot: QueueSnapshot; revision: number }>();
    private offering = new Set<string>();
    private revisions = new Map<string, number>();
    private closed = false;
    private client: Client | null = null;

    constructor(subscribe = true) {
        if (!subscribe) return;
        for (const event of ['trackStart', 'trackAdded', 'tracksAdded', 'queueChanged', 'queueStopped', 'queueEmpty']) {
            queueManager.on(event, (queue: GuildQueue) => this.capture(queue));
        }
        queueManager.on('queueDisconnecting', (queue: GuildQueue, manual: boolean) => {
            if (this.closed) return;
            const snapshot = manual ? null : snapshotQueue(queue);
            this.schedule(queue.guildId, snapshot);
            const revision = this.revisions.get(queue.guildId)!;
            void this.flush(queue.guildId).then(async () => {
                if (snapshot && !manual && !this.busy.has(queue.guildId)) await this.offer(snapshot, revision);
                else if (!snapshot) await this.dismiss(queue.guildId);
            }).catch(error => log.warn('Recovery save failed', error));
        });
    }

    private capture(queue: GuildQueue): void {
        if (this.closed) return;
        this.schedule(queue.guildId, snapshotQueue(queue));
        void this.dismiss(queue.guildId);
    }

    private schedule(guildId: string, snapshot: QueueSnapshot | null): void {
        this.revisions.set(guildId, (this.revisions.get(guildId) ?? 0) + 1);
        clearTimeout(this.timers.get(guildId));
        this.pending.set(guildId, snapshot);
        this.timers.set(guildId, setTimeout(() => {
            void this.flush(guildId).catch(error => log.warn('Recovery save failed', error));
        }, 500));
    }

    private async flush(guildId: string): Promise<void> {
        clearTimeout(this.timers.get(guildId));
        this.timers.delete(guildId);
        const previous = this.writes.get(guildId) ?? Promise.resolve();
        const work = previous.catch(() => undefined).then(async () => {
            if (!this.pending.has(guildId)) return;
            const snapshot = this.pending.get(guildId)!;
            this.pending.delete(guildId);
            try {
                const settings = await guildSettingsManager.getSettings(guildId);
                await this.store.save(guildId, settings.queueRecoveryEnabled ? snapshot : null);
            } catch (error) {
                if (!this.pending.has(guildId)) this.pending.set(guildId, snapshot);
                throw error;
            }
        });
        this.writes.set(guildId, work);
        try { await work; }
        finally { if (this.writes.get(guildId) === work) this.writes.delete(guildId); }
    }

    async start(client: Client): Promise<void> {
        this.client = client;
        for (const guildId of client.guilds.cache.keys()) {
            try {
                if (!(await guildSettingsManager.getSettings(guildId)).queueRecoveryEnabled) {
                    await this.store.save(guildId, null);
                    continue;
                }
                const snapshot = await this.store.load(guildId);
                if (snapshot) await this.offer(snapshot);
                else await this.store.save(guildId, null);
            } catch (error) { log.warn(`Recovery unavailable for ${guildId}`, error); }
        }
    }

    private async offer(snapshot: QueueSnapshot, revision = this.revisions.get(snapshot.guildId) ?? 0): Promise<void> {
        if (this.closed || !this.client || this.offers.has(snapshot.guildId) || this.offering.has(snapshot.guildId) ||
            revision !== (this.revisions.get(snapshot.guildId) ?? 0)) return;
        this.offering.add(snapshot.guildId);
        try {
        const settings = await guildSettingsManager.getSettings(snapshot.guildId);
        if (!settings.queueRecoveryEnabled || Date.now() - snapshot.updatedAt >= RECOVERY_TTL) return;
        const queue = queueManager.getQueue(snapshot.guildId);
        if (queue?.currentTrack || queue?.tracks.length) return;
        const channel = await this.client.guilds.cache.get(snapshot.guildId)?.channels.fetch(snapshot.textChannelId);
        if (!channel || channel.type !== ChannelType.GuildText) return;
        if (this.closed || revision !== (this.revisions.get(snapshot.guildId) ?? 0)) return;
        const nonce = randomUUID();
        const fr = settings.locale === 'fr';
        const message = await channel.send({
            content: fr ? `Lecture interrompue. Reprendre les ${snapshot.tracks.length} pistes sauvegardees ? (24 h maximum)`
                : `Playback interrupted. Resume ${snapshot.tracks.length} saved tracks? (up to 24 hours)`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`recovery:resume:${nonce}`).setLabel(fr ? 'Reprendre' : 'Resume').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`recovery:discard:${nonce}`).setLabel(fr ? 'Ignorer' : 'Discard').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] },
        });
        if (this.closed || revision !== (this.revisions.get(snapshot.guildId) ?? 0)) {
            await message.delete().catch(() => undefined);
            return;
        }
        const timer = setTimeout(() => { void this.dismiss(snapshot.guildId); },
            Math.max(1, RECOVERY_TTL - (Date.now() - snapshot.updatedAt)));
        timer.unref();
        this.offers.set(snapshot.guildId, { snapshot, nonce, message, timer });
        } finally { this.offering.delete(snapshot.guildId); }
    }

    private async dismiss(guildId: string): Promise<void> {
        const offer = this.offers.get(guildId);
        if (!offer) return;
        this.offers.delete(guildId);
        clearTimeout(offer.timer);
        await offer.message.edit({ components: [] }).catch(() => undefined);
    }

    async settingsChanged(guildId: string): Promise<void> {
        await this.dismiss(guildId);
        const queue = queueManager.getQueue(guildId);
        this.schedule(guildId, queue ? snapshotQueue(queue) : null);
        await this.flush(guildId);
    }

    hasOffer(guildId: string): boolean { return this.offers.has(guildId); }

    private async authorized(interaction: ButtonInteraction, snapshot: QueueSnapshot,
        voice: VoiceChannel | StageChannel): Promise<boolean> {
        if (this.closed) return false;
        const member = await getFreshInteractionMember(interaction);
        if (!member || !(await canUseBot(member))) return false;
        if (!(await guildSettingsManager.getSettings(snapshot.guildId)).queueRecoveryEnabled) return false;
        if (!(await canJoinVoiceChannel(voice, snapshot.guildId))) return false;
        if (isBotOwner(member.user.id)) return true;
        const text = interaction.channel;
        return member.voice.channelId === voice.id && Boolean(text && 'permissionsFor' in text &&
            text.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
    }

    async handleButton(interaction: ButtonInteraction): Promise<void> {
        const guildId = interaction.guildId;
        const [, action, nonce] = interaction.customId.split(':');
        const offer = guildId ? this.offers.get(guildId) : undefined;
        const fr = (interaction.locale ?? 'fr').startsWith('fr');
        const unavailable = fr ? 'Reprise indisponible ou non autorisee.' : 'Recovery unavailable or not authorized.';
        if (this.closed || !guildId || !offer || nonce !== offer.nonce || interaction.message.id !== offer.message.id ||
            interaction.channelId !== offer.snapshot.textChannelId || !['resume', 'discard'].includes(action) ||
            Date.now() - offer.snapshot.updatedAt >= RECOVERY_TTL || this.busy.has(guildId)) {
            await interaction.reply({ content: unavailable, flags: MessageFlags.Ephemeral });
            return;
        }
        this.busy.add(guildId);
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const channel = await interaction.guild?.channels.fetch(offer.snapshot.voiceChannelId);
            if (!channel?.isVoiceBased() || !(await this.authorized(interaction, offer.snapshot, channel)) ||
                this.offers.get(guildId) !== offer) {
                await interaction.editReply(unavailable);
                return;
            }
            if (action === 'discard') {
                this.schedule(guildId, null);
                await this.flush(guildId);
                await this.dismiss(guildId);
                await interaction.editReply(fr ? 'File ignoree.' : 'Queue discarded.');
                return;
            }
            if (queueManager.hasQueue(guildId)) {
                await interaction.editReply(fr ? 'Une session existe deja. Termine-la avant de reprendre.' : 'A session already exists. End it before resuming.');
                return;
            }
            const revision = this.revisions.get(guildId) ?? 0;
            this.restoring.set(guildId, { snapshot: offer.snapshot, revision });
            const queue = queueManager.createQueue(guildId, interaction.channel as TextChannel, channel);
            const connection = await queueManager.joinChannel(queue);
            queue.volume = (await guildSettingsManager.getSettings(guildId)).volume;
            await this.dismiss(guildId);
            if (!connection || !(await this.authorized(interaction, offer.snapshot, channel)) ||
                revision !== (this.revisions.get(guildId) ?? 0) || queue.isStopping ||
                queueManager.getQueue(guildId) !== queue || queue.currentTrack || queue.tracks.length) {
                if (queueManager.getQueue(guildId) === queue && !queue.currentTrack && !queue.tracks.length) queueManager.deleteQueue(guildId, true);
                await interaction.editReply(unavailable);
                return;
            }
            // The snapshot may contain maxQueueTracks upcoming tracks plus the interrupted one.
            queue.tracks = [...offer.snapshot.tracks];
            queueManager.emit('tracksAdded', queue, queue.tracks);
            const started = await queueManager.playNext(guildId);
            await interaction.editReply(started.status === 'started' ? (fr ? 'File reprise, piste interrompue depuis le debut.' : 'Queue resumed; interrupted track starts from the beginning.')
                : (fr ? 'Impossible de lancer la lecture. Consulte /stats.' : 'Playback could not start. Check /stats.'));
        } finally { this.busy.delete(guildId); this.restoring.delete(guildId); }
    }

    async shutdown(): Promise<void> {
        this.closed = true;
        for (const queue of queueManager.getAllQueues().values()) {
            const restoring = this.restoring.get(queue.guildId);
            const snapshot = snapshotQueue(queue) ?? (restoring &&
                restoring.revision === (this.revisions.get(queue.guildId) ?? 0) ? restoring.snapshot : null);
            this.schedule(queue.guildId, snapshot);
        }
        for (const offer of this.offers.values()) clearTimeout(offer.timer);
        await Promise.all([...new Set([...this.pending.keys(), ...this.writes.keys()])].map(id => this.flush(id)));
    }
}

export const queueRecoveryManager = new QueueRecoveryManager();
