type ReadinessWriter = (line: string) => void;

const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/i;
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_PENDING_CHALLENGES = 32;

function formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 23);
}

export class RuntimeReadiness {
    private readonly pendingChallenges = new Set<string>();
    private isDiscordReady: () => boolean = () => false;

    constructor(
        private readonly getBuildSha: () => string | undefined = () => process.env.BOT_BUILD_SHA,
        private readonly writeLine: ReadinessWriter = (line) => process.stdout.write(`${line}\n`),
        private readonly now: () => Date = () => new Date()
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

        this.rememberChallenge(challenge);
        return true;
    }

    notifyDiscordStateChanged(): void {
        if (!this.isDiscordReady()) return;
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

    private writeReadiness(challenge: string): boolean {
        const candidate = this.getBuildSha()?.trim() ?? '';
        if (!BUILD_SHA_PATTERN.test(candidate)) return false;

        this.writeLine(
            `${formatTimestamp(this.now())} INFO  [Readiness] `
            + `challenge=${challenge} build=${candidate.toLowerCase()} discordReady=true`
        );
        return true;
    }
}

export const runtimeReadiness = new RuntimeReadiness();
