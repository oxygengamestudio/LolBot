import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from '../utils/Logger.js';

const log = logger.createModuleLogger('Telemetry');

export interface RuntimeTelemetrySnapshot {
    cpuPercent: number;
    rssMb: number;
    eventLoopP95Ms: number;
    mediaKbps: number;
    mediaBytes: number;
    cacheHits: number;
    cacheMisses: number;
    playbackRetries: number;
    reconnectAttempts: number;
    startLatencyP95Ms: number;
    joinLatencyP95Ms: number;
    resolutionLatencyP95Ms: number;
}

class RuntimeTelemetry {
    private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
    private readonly startLatencies: number[] = [];
    private readonly joinLatencies: number[] = [];
    private readonly resolutionLatencies: number[] = [];
    private mediaBytes = 0;
    private cacheHits = 0;
    private cacheMisses = 0;
    private playbackRetries = 0;
    private reconnectAttempts = 0;
    private previousCpu = process.cpuUsage();
    private previousSampleAt = process.hrtime.bigint();
    private previousMediaBytes = 0;
    private latest: RuntimeTelemetrySnapshot;
    private samplesSinceLog = 0;

    constructor() {
        this.eventLoop.enable();
        this.latest = this.sample();
        const timer = setInterval(() => {
            this.latest = this.sample();
            this.samplesSinceLog += 1;
            if (this.samplesSinceLog >= 4) {
                this.samplesSinceLog = 0;
                log.info('runtime_metrics', this.latest);
            }
        }, 15_000);
        timer.unref?.();
    }

    recordMediaBytes(bytes: number): void {
        if (Number.isFinite(bytes) && bytes > 0) this.mediaBytes += bytes;
    }

    recordCacheResult(hit: boolean): void {
        if (hit) this.cacheHits += 1;
        else this.cacheMisses += 1;
    }

    recordPlaybackRetry(): void {
        this.playbackRetries += 1;
    }

    recordReconnectAttempt(): void {
        this.reconnectAttempts += 1;
    }

    recordPlaybackStart(totalMs: number, joinMs: number | null, resolutionMs: number | null): void {
        this.pushLatency(this.startLatencies, totalMs);
        if (joinMs !== null) this.pushLatency(this.joinLatencies, joinMs);
        if (resolutionMs !== null) this.pushLatency(this.resolutionLatencies, resolutionMs);
    }

    getSnapshot(): RuntimeTelemetrySnapshot {
        return {
            ...this.latest,
            mediaBytes: this.mediaBytes,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            playbackRetries: this.playbackRetries,
            reconnectAttempts: this.reconnectAttempts,
            startLatencyP95Ms: this.percentile95(this.startLatencies),
            joinLatencyP95Ms: this.percentile95(this.joinLatencies),
            resolutionLatencyP95Ms: this.percentile95(this.resolutionLatencies),
        };
    }

    private sample(): RuntimeTelemetrySnapshot {
        const now = process.hrtime.bigint();
        const elapsedMicros = Math.max(1, Number(now - this.previousSampleAt) / 1_000);
        const cpu = process.cpuUsage(this.previousCpu);
        const cpuPercent = ((cpu.user + cpu.system) / elapsedMicros) * 100;
        const elapsedSeconds = elapsedMicros / 1_000_000;
        const mediaDelta = Math.max(0, this.mediaBytes - this.previousMediaBytes);
        const eventLoopP95Ms = Number.isFinite(this.eventLoop.percentile(95))
            ? this.eventLoop.percentile(95) / 1_000_000
            : 0;

        this.previousCpu = process.cpuUsage();
        this.previousSampleAt = now;
        this.previousMediaBytes = this.mediaBytes;
        this.eventLoop.reset();

        return {
            cpuPercent: this.round(cpuPercent),
            rssMb: this.round(process.memoryUsage().rss / 1024 / 1024),
            eventLoopP95Ms: this.round(eventLoopP95Ms),
            mediaKbps: this.round((mediaDelta * 8) / Math.max(0.001, elapsedSeconds) / 1000),
            mediaBytes: this.mediaBytes,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            playbackRetries: this.playbackRetries,
            reconnectAttempts: this.reconnectAttempts,
            startLatencyP95Ms: this.percentile95(this.startLatencies),
            joinLatencyP95Ms: this.percentile95(this.joinLatencies),
            resolutionLatencyP95Ms: this.percentile95(this.resolutionLatencies),
        };
    }

    private pushLatency(target: number[], value: number): void {
        if (!Number.isFinite(value) || value < 0) return;
        target.push(value);
        if (target.length > 200) target.shift();
    }

    private percentile95(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        return this.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0);
    }

    private round(value: number): number {
        return Math.round(value * 10) / 10;
    }
}

export const runtimeTelemetry = new RuntimeTelemetry();
