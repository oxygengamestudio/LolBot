const SENSITIVE_QUERY_KEYS = new Set([
    'access_token',
    'api_key',
    'client_secret',
    'key',
    'token',
]);

export function sanitizeUrlForLogs(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        for (const key of parsed.searchParams.keys()) {
            if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
                parsed.searchParams.set(key, '[redacted]');
            }
        }
        return parsed.toString();
    } catch {
        return rawUrl;
    }
}

export function assertHttpsUrlAllowed(rawUrl: string, allowedDomains: readonly string[]): URL {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`Blocked non-HTTPS URL: ${sanitizeUrlForLogs(rawUrl)}`);
    }

    const host = parsed.hostname.toLowerCase();
    const isAllowed = allowedDomains.some((domain) => {
        const normalized = domain.toLowerCase();
        return host === normalized || host.endsWith(`.${normalized}`);
    });

    if (!isAllowed) {
        throw new Error(`Blocked host: ${host}`);
    }

    return parsed;
}
