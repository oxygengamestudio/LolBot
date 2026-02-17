import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, GuildMember, MessageFlags } from 'discord.js';
import { queueManager } from '../services/QueueManager.js';
import { audioWrapper } from '../audio/AudioWrapper.js';
import { canUseBot } from '../utils/permissions.js';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('StatsCmd');

export const data = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Affiche les informations de connexion et la qualite audio')
    .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: '❌ Cette commande est disponible uniquement sur un serveur.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const member = interaction.member as GuildMember;
    if (!(await canUseBot(member))) {
        await interaction.reply({
            content: '❌ Vous n\'avez pas la permission d\'utiliser ce bot.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const guildId = interaction.guildId!;
    const queue = queueManager.getQueue(guildId);
    const connection = queue?.connection ?? null;

    const connectionStatus = connection?.state?.status ?? 'disconnected';
    const ping = connection?.ping;
    const wsPing = ping?.ws;
    const udpPing = ping?.udp;

    const voiceChannelName = queue?.voiceChannel?.name ?? 'Aucun';
    const membersCount = queue?.voiceChannel
        ? queue.voiceChannel.members.filter((m) => !m.user.bot).size
        : 0;

    const playerStatus = queue?.player?.state?.status ?? 'idle';
    const currentTrack = queue?.currentTrack;
    const volume = queue?.volume ?? 100;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sourceBitrate = currentTrack
        ? await audioWrapper.getBestAudioBitrateKbps(currentTrack.url)
        : null;
    const outputBitrate = audioWrapper.getDiscordOutputBitrateKbps();

    const audioQuality = [
        `Source: ${sourceBitrate ? `${sourceBitrate} kbps` : 'n/a'}`,
        `Discord: ${outputBitrate} kbps (Opus 48 kHz)`,
    ].join('\n');

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Stats du bot')
        .addFields(
            { name: 'Connexion vocale', value: `Etat: ${connectionStatus}`, inline: true },
            { name: 'Ping', value: formatPing(wsPing, udpPing), inline: true },
            { name: 'Canal vocal', value: `${voiceChannelName} (${membersCount} membre(s))`, inline: false },
            { name: 'Lecteur', value: `Etat: ${playerStatus}`, inline: true },
            { name: 'Volume', value: `${volume}%`, inline: true },
            { name: 'Qualite audio', value: audioQuality, inline: false },
            { name: 'En lecture', value: currentTrack ? formatTrack(currentTrack.title, currentTrack.duration) : 'Aucune', inline: false }
        )
        .setFooter({ text: `Uptime: ${formatUptime(process.uptime())}` });

    await interaction.editReply({ embeds: [embed] });
    deleteEphemeralAfterDelay(interaction);
    log.debug('Commande /stats repondue');
}

function deleteEphemeralAfterDelay(interaction: ChatInputCommandInteraction): void {
    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch {
            // Ignore
        }
    }, 10_000);
}

function formatPing(wsPing?: number, udpPing?: number): string {
    const ws = wsPing !== undefined ? `${Math.round(wsPing)} ms` : 'n/a';
    const udp = udpPing !== undefined ? `${Math.round(udpPing)} ms` : 'n/a';
    return `WS: ${ws}\nUDP: ${udp}`;
}

function formatTrack(title: string, duration: number): string {
    return `${title} (${formatDuration(duration)})`;
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
    if (days > 0) parts.push(`${days}j`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
}
