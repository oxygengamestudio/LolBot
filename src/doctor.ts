import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
}

interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}

export interface DoctorDependencies {
    runCommand?: (command: string, args: string[]) => CommandResult;
    loadModule?: (moduleName: string) => unknown;
    nodeVersion?: string;
}

function defaultRunCommand(command: string, args: string[]): CommandResult {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
    });

    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
    };
}

function firstLine(value: string): string {
    return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function commandCheck(
    name: string,
    command: string,
    args: string[],
    runCommand: (command: string, args: string[]) => CommandResult,
): DoctorCheck {
    const result = runCommand(command, args);
    const detail = firstLine(result.stdout) || firstLine(result.stderr) || result.error?.message || 'aucune sortie';
    return {
        name,
        ok: result.status === 0 && !result.error,
        detail,
    };
}

function moduleCheck(name: string, moduleName: string, loadModule: (moduleName: string) => unknown): DoctorCheck {
    try {
        loadModule(moduleName);
        return { name, ok: true, detail: `${moduleName} chargé` };
    } catch (error) {
        return {
            name,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

export function collectDoctorChecks(dependencies: DoctorDependencies = {}): DoctorCheck[] {
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const loadModule = dependencies.loadModule ?? ((moduleName: string) => require(moduleName));
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const [major, minor] = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
    const supportedNode = Number.isFinite(major) && Number.isFinite(minor)
        && (major > 22 || (major === 22 && minor >= 12));

    return [
        {
            name: 'node',
            ok: supportedNode,
            detail: `Node.js ${nodeVersion} (minimum 22.12)`,
        },
        commandCheck('ffmpeg', 'ffmpeg', ['-version'], runCommand),
        commandCheck('yt-dlp', 'yt-dlp', ['--version'], runCommand),
        moduleCheck('opus-native', '@discordjs/opus', loadModule),
        moduleCheck('opus-fallback', 'opusscript', loadModule),
    ];
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
    return checks
        .map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`)
        .join('\n');
}

export function runDoctor(dependencies: DoctorDependencies = {}): number {
    const checks = collectDoctorChecks(dependencies);
    console.log(formatDoctorReport(checks));
    const requiredChecks = checks.filter((check) => ['node', 'ffmpeg', 'yt-dlp'].includes(check.name));
    const hasOpusEncoder = checks.some(
        (check) => (check.name === 'opus-native' || check.name === 'opus-fallback') && check.ok
    );
    return requiredChecks.every((check) => check.ok) && hasOpusEncoder ? 0 : 1;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (executedPath === resolve(fileURLToPath(import.meta.url))) {
    process.exitCode = runDoctor();
}
