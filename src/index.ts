import { readFileSync } from 'node:fs';

type PackageMetadata = {
    name?: string;
    version?: string;
};

function formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function readPackageMetadata(): PackageMetadata {
    try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata;
    } catch {
        return {};
    }
}

function formatBuildSuffix(): string {
    const buildSha = process.env.BOT_BUILD_SHA?.trim();
    if (!buildSha || buildSha === 'local') {
        return '';
    }

    return ` (build ${buildSha.slice(0, 7)})`;
}

const packageMetadata = readPackageMetadata();
const botName = packageMetadata.name === 'lolbot' ? 'LolBot' : packageMetadata.name ?? 'LolBot';
const botVersion = packageMetadata.version ?? 'unknown';

console.log(`${formatTimestamp()} INFO  [Bootstrap] ${botName} v${botVersion}${formatBuildSuffix()}`);

try {
    await import('./bot.js');
} catch (error) {
    console.error(`${formatTimestamp()} ERROR [Bootstrap] Bot startup failed`, error);
    process.exitCode = 1;
}
