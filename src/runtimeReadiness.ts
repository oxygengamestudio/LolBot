import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type ReadinessWriter = (line: string) => void;

export type RuntimeReadinessReceipt = {
    schemaVersion: 1;
    challenge: string;
    buildSha: string;
    discordReady: true;
    generatedAt: string;
    expiresAtMs: number;
};

type ReadinessReceiptWriter = (receipt: RuntimeReadinessReceipt) => boolean;
type ReadinessReceiptInvalidator = () => boolean;

const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/i;
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_PENDING_CHALLENGES = 32;
const RECEIPT_FILENAME = 'runtime-readiness.json';
const RECEIPT_TTL_MS = 15_000;

function formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 23);
}

function defaultDataDir(): string {
    return process.env.DATA_DIR?.trim() || join(process.cwd(), 'data');
}

export function writeRuntimeReadinessReceipt(
    receipt: RuntimeReadinessReceipt,
    dataDir = defaultDataDir()
): boolean {
    const targetPath = join(dataDir, RECEIPT_FILENAME);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

    try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        renameSync(temporaryPath, targetPath);
        return true;
    } catch {
        try {
            rmSync(temporaryPath, { force: true });
        } catch {
            // Best effort: the unique temporary path is never accepted as readiness evidence.
        }
        return false;
    }
}

export function clearRuntimeReadinessReceipt(dataDir = defaultDataDir()): boolean {
    try {
        rmSync(join(dataDir, RECEIPT_FILENAME), { force: true });
        return true;
    } catch {
        return false;
    }
}

export class RuntimeReadiness {
    private readonly pendingChallenges = new Set<string>();
    private isDiscordReady: () => boolean = () => false;

    constructor(
        private readonly getBuildSha: () => string | undefined = () => process.env.BOT_BUILD_SHA,
        private readonly writeLine: ReadinessWriter = (line) => process.stdout.write(`${line}\n`),
        private readonly now: () => Date = () => new Date(),
        private readonly writeReceipt: ReadinessReceiptWriter = () => true,
        private readonly clearReceipt: ReadinessReceiptInvalidator = () => true
    ) {}

    setDiscordReadyProbe(probe: () => boolean): void {
        this.isDiscordReady = probe;
    }

    handleControlCommand(line: string): boolean {
        const match = line.match(/^lolbot:ready ([0-9a-f]{64})$/i);
        if (!match?.[1] || !CHALLENGE_PATTERN.test(match[1])) {
            return false;
        }

        const challenge = match[1].toLowerCase();
        if (this.isDiscordReady()) {
            if (this.writeReadiness(challenge)) {
                this.pendingChallenges.delete(challenge);
            } else {
                this.rememberChallenge(challenge);
            }
            return true;
        }

        this.invalidateReceipt();
        this.rememberChallenge(challenge);
        return true;
    }

    notifyDiscordStateChanged(): void {
        if (!this.isDiscordReady()) {
            this.invalidateReceipt();
            return;
        }
        for (const challenge of this.pendingChallenges) {
            if (this.writeReadiness(challenge)) {
                this.pendingChallenges.delete(challenge);
            }
        }
    }

    private rememberChallenge(challenge: string): void {
        if (!this.pendingChallenges.has(challenge) && this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
            const oldest = this.pendingChallenges.values().next().value;
            if (oldest) this.pendingChallenges.delete(oldest);
        }
        this.pendingChallenges.add(challenge);
    }

    private invalidateReceipt(): void {
        try {
            this.clearReceipt();
        } catch {
            // Readiness remains fail-closed because the receipt also has a short expiry.
        }
    }

    private writeReadiness(challenge: string): boolean {
        const candidate = this.getBuildSha()?.trim() ?? '';
        if (!BUILD_SHA_PATTERN.test(candidate)) return false;

        const buildSha = candidate.toLowerCase();
        const generatedAt = this.now();
        const receipt: RuntimeReadinessReceipt = {
            schemaVersion: 1,
            challenge,
            buildSha,
            discordReady: true,
            generatedAt: generatedAt.toISOString(),
            expiresAtMs: generatedAt.getTime() + RECEIPT_TTL_MS,
        };

        let receiptWritten = false;
        let lineWritten = false;
        try {
            receiptWritten = this.writeReceipt(receipt);
        } catch {
            receiptWritten = false;
        }
        try {
            this.writeLine(
                `${formatTimestamp(generatedAt)} INFO  [Readiness] `
                + `challenge=${challenge} build=${buildSha} discordReady=true`
            );
            lineWritten = true;
        } catch {
            lineWritten = false;
        }
        return receiptWritten || lineWritten;
    }
}

export const runtimeReadiness = new RuntimeReadiness(
    undefined,
    undefined,
    undefined,
    writeRuntimeReadinessReceipt,
    clearRuntimeReadinessReceipt
);
