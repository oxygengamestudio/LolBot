import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.ts';
import { queueManager } from '../src/services/QueueManager.ts';
import { youtubeService } from '../src/services/YouTubeService.ts';
import { guildSettingsManager } from '../src/services/GuildSettingsManager.ts';

const DEFAULT_DURATION_SECONDS = 600;
const DEFAULT_RAMP_STEP_SECONDS = 45;
const DEFAULT_METRIC_INTERVAL_SECONDS = 5;
const DEFAULT_QUEUE_BUFFER = 2;

function getEnvInt(name, fallback) {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    return parsed;
}

function parseTargets(rawTargets) {
    const targets = rawTargets
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [guildId, voiceChannelId, textChannelId] = entry.split(':').map((part) => part?.trim());
            if (!guildId || !voiceChannelId || !textChannelId) {
                throw new Error(`Invalid target format: ${entry}. Expected guildId:voiceChannelId:textChannelId`);
            }
            return { guildId, voiceChannelId, textChannelId };
        });

    if (targets.length === 0) {
        throw new Error('No stress targets provided. Set STRESS_TARGETS.');
    }

    return targets;
}

function parseUrls(rawUrls) {
    const urls = rawUrls
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    if (urls.length === 0) {
        throw new Error('No media URLs provided. Set STRESS_URLS.');
    }

    return urls;
}

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const rawTargets = process.env.STRESS_TARGETS ?? '';
const rawUrls = process.env.STRESS_URLS ?? '';
const runDurationSeconds = getEnvInt('STRESS_DURATION_SEC', DEFAULT_DURATION_SECONDS);
const rampStepSeconds = getEnvInt('STRESS_RAMP_STEP_SEC', DEFAULT_RAMP_STEP_SECONDS);
const metricsIntervalSeconds = getEnvInt('STRESS_METRICS_INTERVAL_SEC', DEFAULT_METRIC_INTERVAL_SECONDS);
const queueBufferSize = getEnvInt('STRESS_QUEUE_BUFFER', DEFAULT_QUEUE_BUFFER);
const outputDir = process.env.STRESS_OUTPUT_DIR?.trim() || join(config.paths.data, 'stress');

const targets = parseTargets(rawTargets);
const urls = parseUrls(rawUrls);

if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
}

const startedAt = new Date();
const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
const csvPath = join(outputDir, `stress-single-instance-${timestamp}.csv`);
const summaryPath = join(outputDir, `stress-single-instance-${timestamp}.summary.txt`);

writeFileSync(
    csvPath,
    'iso_time,elapsed_s,active_targets,active_queues,cpu_percent,rss_mb,heap_used_mb,event_loop_ms,p95_start_latency_ms,error_count\n',
    'utf8'
);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

let previousCpu = process.cpuUsage();
let previousCpuAt = Date.now();
let intervalId = null;
let shuttingDown = false;
let errors = 0;
let maxActiveTargets = 0;

const activeGuildIds = new Set();
const pendingStartByGuild = new Map();
const startLatencies = [];
const preparedTargets = [];

let trackTemplates = [];

function buildTrackFromTemplate(template) {
    if (!client.user) {
        throw new Error('Client user unavailable while cloning track');
    }

    return {
        ...template,
        requestedBy: 'StressTest',
        requestedById: client.user.id,
    };
}

function pickTrack() {
    if (trackTemplates.length === 0) {
        throw new Error('No track templates loaded');
    }
    const selected = trackTemplates[Math.floor(Math.random() * trackTemplates.length)];
    return buildTrackFromTemplate(selected);
}

function appendMetricRow() {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousCpuAt);
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    previousCpuAt = now;

    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cpuPercent = (cpuMs / elapsedMs) * 100;
    const memory = process.memoryUsage();
    const eventLoopMs = Number(loopDelay.mean / 1_000_000) || 0;
    loopDelay.reset();

    const row = [
        new Date(now).toISOString(),
        Math.floor((now - startedAt.getTime()) / 1000),
        activeGuildIds.size,
        queueManager.getAllQueues().size,
        cpuPercent.toFixed(2),
        (memory.rss / 1024 / 1024).toFixed(2),
        (memory.heapUsed / 1024 / 1024).toFixed(2),
        eventLoopMs.toFixed(2),
        percentile(startLatencies, 95).toFixed(2),
        errors,
    ].join(',');

    appendFileSync(csvPath, `${row}\n`, 'utf8');
}

async function fillQueue(guildId) {
    const queue = queueManager.getQueue(guildId);
    if (!queue) return;

    while (queue.tracks.length < queueBufferSize) {
        const added = queueManager.addTrack(guildId, pickTrack());
        if (added <= 0) {
            errors += 1;
            break;
        }
    }
}

async function activateTarget(target) {
    const existingQueue = queueManager.getQueue(target.guildId);
    const queue = existingQueue ?? queueManager.createQueue(target.guildId, target.textChannel, target.voiceChannel);

    await guildSettingsManager.updateSettings(target.guildId, {
        stayConnected: true,
        stayConnectedAlways: true,
        pauseOnEmptyChannelWhenAlwaysConnected: false,
        crossfadeEnabled: false,
    });

    await fillQueue(target.guildId);

    pendingStartByGuild.set(target.guildId, Date.now());
    const started = await queueManager.playNext(target.guildId);
    if (!started) {
        errors += 1;
        pendingStartByGuild.delete(target.guildId);
    }

    activeGuildIds.add(target.guildId);
    maxActiveTargets = Math.max(maxActiveTargets, activeGuildIds.size);

    if (!existingQueue && queue.connection) {
        queue.connection.on('error', () => {
            errors += 1;
        });
    }
}

async function resolveTargets() {
    for (const target of targets) {
        const guild = await client.guilds.fetch(target.guildId);
        const voiceChannel = await guild.channels.fetch(target.voiceChannelId);
        const textChannel = await guild.channels.fetch(target.textChannelId);

        if (!voiceChannel || !voiceChannel.isVoiceBased()) {
            throw new Error(`Invalid voice channel for target ${target.guildId}`);
        }

        if (!textChannel || !textChannel.isTextBased()) {
            throw new Error(`Invalid text channel for target ${target.guildId}`);
        }

        preparedTargets.push({
            ...target,
            guild,
            voiceChannel,
            textChannel,
        });
    }
}

async function loadTrackTemplates() {
    if (!client.user) {
        throw new Error('Client user unavailable');
    }

    const templates = [];
    for (const url of urls) {
        const track = await youtubeService.createTrackFromUrl(url, 'StressTest', client.user.id);
        if (!track) {
            throw new Error(`Unable to resolve track from URL: ${url}`);
        }
        templates.push(track);
    }

    trackTemplates = templates;
}

queueManager.on('trackStart', (queue) => {
    const pending = pendingStartByGuild.get(queue.guildId);
    if (pending) {
        startLatencies.push(Date.now() - pending);
        pendingStartByGuild.delete(queue.guildId);
    }

    void fillQueue(queue.guildId);
});

queueManager.on('queueEmpty', (queue) => {
    if (!activeGuildIds.has(queue.guildId)) {
        return;
    }

    void (async () => {
        await fillQueue(queue.guildId);
        await queueManager.playNext(queue.guildId);
    })();
});

queueManager.on('queueDeleted', (guildId) => {
    if (activeGuildIds.has(guildId)) {
        errors += 1;
    }
});

async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }

    try {
        appendMetricRow();
    } catch {
        // Ignore
    }

    for (const guildId of activeGuildIds) {
        try {
            queueManager.deleteQueue(guildId);
        } catch {
            // Ignore
        }
    }

    try {
        await client.destroy();
    } catch {
        // Ignore
    }

    const summaryLines = [
        `Started: ${startedAt.toISOString()}`,
        `Duration seconds: ${runDurationSeconds}`,
        `Ramp step seconds: ${rampStepSeconds}`,
        `Targets configured: ${targets.length}`,
        `Max active targets reached: ${maxActiveTargets}`,
        `Final active queues: ${queueManager.getAllQueues().size}`,
        `Track start latency p95 (ms): ${percentile(startLatencies, 95).toFixed(2)}`,
        `Total errors: ${errors}`,
        `CSV: ${csvPath}`,
    ];

    writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

    console.log(summaryLines.join('\n'));
    console.log(`Summary: ${summaryPath}`);

    process.exit(code);
}

process.on('SIGINT', () => {
    void shutdown(0);
});
process.on('SIGTERM', () => {
    void shutdown(0);
});

async function waitForReady() {
    if (client.isReady()) return;
    await new Promise((resolve) => {
        client.once('ready', resolve);
    });
}

async function main() {
    console.log(`[stress] output CSV: ${csvPath}`);
    console.log(`[stress] targets: ${targets.length}`);
    console.log(`[stress] duration: ${runDurationSeconds}s, ramp step: ${rampStepSeconds}s`);

    await client.login(config.discord.token);
    await waitForReady();

    await resolveTargets();
    await loadTrackTemplates();

    intervalId = setInterval(appendMetricRow, metricsIntervalSeconds * 1000);

    const started = Date.now();
    for (let i = 0; i < preparedTargets.length; i += 1) {
        const elapsed = (Date.now() - started) / 1000;
        if (elapsed >= runDurationSeconds) {
            break;
        }

        const target = preparedTargets[i];
        console.log(`[stress] activate ${i + 1}/${preparedTargets.length}: ${target.guildId}`);
        try {
            await activateTarget(target);
        } catch (error) {
            errors += 1;
            console.error(`[stress] activation failed for ${target.guildId}`, error);
        }

        if (i < preparedTargets.length - 1) {
            await sleep(rampStepSeconds * 1000);
        }
    }

    const elapsedAfterRamp = Date.now() - started;
    const remainingMs = Math.max(0, runDurationSeconds * 1000 - elapsedAfterRamp);
    if (remainingMs > 0) {
        await sleep(remainingMs);
    }

    await shutdown(0);
}

main().catch((error) => {
    console.error('[stress] fatal error', error);
    void shutdown(1);
});
