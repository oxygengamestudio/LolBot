import { readFileSync } from 'node:fs';

/** Version publiée du bot, lue une fois dans package.json (présent à côté de `dist/` dans l'image). */
function readBotVersion(): string {
    try {
        const metadata = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
        ) as { version?: unknown };
        return typeof metadata.version === 'string' && metadata.version ? metadata.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

export const botVersion = readBotVersion();
