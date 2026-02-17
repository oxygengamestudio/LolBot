export function getDiscordErrorCode(error: unknown): number | null {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'number') {
        return code;
    }
    if (typeof code === 'string') {
        const parsed = Number.parseInt(code, 10);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

export function isInteractionAlreadyAcknowledgedError(error: unknown): boolean {
    return getDiscordErrorCode(error) === 40060;
}

export function isUnknownInteractionError(error: unknown): boolean {
    return getDiscordErrorCode(error) === 10062;
}

export function isKnownInteractionResponseError(error: unknown): boolean {
    const code = getDiscordErrorCode(error);
    return code === 40060 || code === 10062;
}
