import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, GuildMember } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { audioWrapper } from '../audio/AudioWrapper.js';
import { commandDescriptionLocalizations, t } from '../utils/i18n.js';
import { ensureCanUseBot, getInteractionLocale, replyEphemeral } from '../utils/commandHelpers.js';
import { logger } from '../utils/Logger.js';
import { safeContent } from '../utils/text.js';
import { runtimeTelemetry } from '../services/RuntimeTelemetry.js';

const log = logger.createModuleLogger('StatsCmd');

export const data = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show voice and audio stats')
    .setDescriptionLocalizations(commandDescriptionLocalizations('Affiche les informations de connexion et la qualite audio', 'Show voice and audio stats'))
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await replyEphemeral(interaction, `❌ ${t(interaction.locale, 'error.guildOnly')}`, false);
        return;
    }

    const member = interaction.member as GuildMember;
    const locale = await getInteractionLocale(interaction);
    if (!(await ensureCanUseBot(interaction, member))) {
        return;
    }

    const guildId = interaction.guildId!;
    const queue = queueManager.getQueue(guildId);
    const connection = queue?.connection ?? null;
    const connectionStatus = connection?.state?.status ?? 'disconnected';
    const ping = connection?.ping;
    const wsPing = ping?.ws;
    const udpPing = ping?.udp;

    const voiceChannelName = queue?.voiceChannel?.name ?? t(locale, 'common.none');
    const membersCount = queue?.voiceChannel
        ? queue.voiceChannel.members.filter((m) => !m.user.bot).size
        : 0;

    const playerStatus = queue?.player?.state?.status ?? 'idle';
    const currentTrack = queue?.currentTrack;
    const volume = queue?.volume ?? 100;
    const telemetry = queue?.lastStartMetrics;

    await interaction.deferReply({ flags: 64 });

    const sourceBitrate = currentTrack
        ? audioWrapper.getEstimatedAudioBitrateKbps(guildId, currentTrack)
        : null;
    const outputBitrate = audioWrapper.getDiscordOutputBitrateKbps();
    const sourceMode = queue ? audioWrapper.getLastSourceMode(guildId) : 'unknown';
    const runtime = runtimeTelemetry.getSnapshot();

    const audioQuality = [
        `${t(locale, 'stats.source')}: ${sourceBitrate ? `${sourceBitrate} kbps` : 'n/a'}`,
        `${t(locale, 'stats.discord')}: ${outputBitrate} kbps (Opus 48 kHz)`,
    ].join('\n');

    const telemetryValue = telemetry
        ? t(locale, 'stats.telemetryValue', {
            joinMs: telemetry.joinMs ?? 'n/a',
            warmup: telemetry.warmHit ? `hit (${telemetry.warmupMs ?? 0}ms)` : `${telemetry.warmupMs ?? 'n/a'}ms`,
            resourceMs: telemetry.resourceMs ?? 'n/a',
            sourceMode,
            crossfade: 'off (gapless)',
        })
        : 'n/a';

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(t(locale, 'stats.title'))
        .addFields(
            { name: t(locale, 'stats.voiceConnection'), value: `Etat: ${connectionStatus}`, inline: true },
            { name: t(locale, 'stats.ping'), value: formatPing(wsPing, udpPing), inline: true },
            { name: t(locale, 'stats.voiceChannel'), value: t(locale, 'stats.queuedMembers', { channel: safeContent(voiceChannelName), count: membersCount }), inline: false },
            { name: t(locale, 'stats.player'), value: `Etat: ${playerStatus}\nVolume: ${volume}%`, inline: true },
            { name: t(locale, 'stats.audioQuality'), value: audioQuality, inline: false },
            { name: t(locale, 'stats.telemetry'), value: telemetryValue, inline: false },
            {
                name: 'Runtime',
                value: [
                    `CPU: ${runtime.cpuPercent}% • RSS: ${runtime.rssMb} MB • event-loop p95: ${runtime.eventLoopP95Ms} ms`,
                    `Média observé: ${runtime.mediaKbps} kb/s • cache: ${runtime.cacheHits} hit / ${runtime.cacheMisses} miss`,
                    `Démarrage p95: ${runtime.startLatencyP95Ms} ms • join: ${runtime.joinLatencyP95Ms} ms • résolution: ${runtime.resolutionLatencyP95Ms} ms`,
                    `Retries: ${runtime.playbackRetries} • reconnexions: ${runtime.reconnectAttempts}`,
                ].join('\n'),
                inline: false,
            },
            {
                name: t(locale, 'stats.nowPlaying'),
                value: currentTrack
                    ? t(locale, 'stats.track', { title: safeContent(currentTrack.title), duration: formatDuration(currentTrack.duration) })
                    : t(locale, 'stats.none'),
                inline: false,
            }
        )
        .setFooter({ text: `${t(locale, 'stats.uptime')}: ${formatUptime(process.uptime())}` });

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    log.debug('Commande /stats repondue');
}

function formatPing(wsPing?: number, udpPing?: number): string {
    const ws = wsPing !== undefined ? `${Math.round(wsPing)} ms` : 'n/a';
    const udp = udpPing !== undefined ? `${Math.round(udpPing)} ms` : 'n/a';
    return `WS: ${ws}\nUDP: ${udp}`;
}

function formatDuration(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatUptime(totalSeconds: number): string {
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor((totalSeconds / 60) % 60);
    const hours = Math.floor((totalSeconds / 3600) % 24);
    const days = Math.floor(totalSeconds / 86400);

    const parts = [] as string[];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
}
