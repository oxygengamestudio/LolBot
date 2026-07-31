import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
    loadModule?: (moduleName: string) => unknown | Promise<unknown>;
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

async function moduleCheck(
    name: string,
    moduleName: string,
    loadModule: (moduleName: string) => unknown | Promise<unknown>,
    validate?: (loaded: unknown) => void | Promise<void>,
): Promise<DoctorCheck> {
    try {
        const loaded = await loadModule(moduleName);
        await validate?.(loaded);
        return { name, ok: true, detail: `${moduleName} chargé` };
    } catch (error) {
        return {
            name,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

async function validateVoiceCipher(loaded: unknown): Promise<void> {
    const backend = loaded as {
        xchacha20poly1305?: (
            key: Uint8Array,
            nonce: Uint8Array,
            additionalData: Uint8Array,
        ) => {
            encrypt: (plaintext: Uint8Array) => Uint8Array;
            decrypt: (ciphertext: Uint8Array) => Uint8Array;
        };
    };
    if (typeof backend.xchacha20poly1305 !== 'function') {
        throw new Error('backend XChaCha20-Poly1305 indisponible');
    }

    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => index + 32);
    const additionalData = Uint8Array.from([0x80, 0x78, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const plaintext = Uint8Array.from([0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03]);
    const cipher = backend.xchacha20poly1305(key, nonce, additionalData);
    const decrypted = cipher.decrypt(cipher.encrypt(plaintext));
    if (decrypted.length !== plaintext.length || decrypted.some((byte, index) => byte !== plaintext[index])) {
        throw new Error('échec du round-trip XChaCha20-Poly1305');
    }
}

export async function collectDoctorChecks(dependencies: DoctorDependencies = {}): Promise<DoctorCheck[]> {
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const loadModule = dependencies.loadModule ?? ((moduleName: string) => import(moduleName));
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const [major, minor] = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
    const supportedNode = Number.isFinite(major) && Number.isFinite(minor)
        && (major > 22 || (major === 22 && minor >= 12));

    const moduleChecks = await Promise.all([
        moduleCheck('opus-native', '@discordjs/opus', loadModule),
        moduleCheck('opus-fallback', 'opusscript', loadModule),
        moduleCheck('dave-native', '@snazzah/davey', loadModule),
        moduleCheck('voice-crypto', '@noble/ciphers/chacha.js', loadModule, validateVoiceCipher),
    ]);

    return [
        {
            name: 'node',
            ok: supportedNode,
            detail: `Node.js ${nodeVersion} (minimum 22.12)`,
        },
        commandCheck('ffmpeg', 'ffmpeg', ['-version'], runCommand),
        commandCheck('yt-dlp', 'yt-dlp', ['--version'], runCommand),
        ...moduleChecks,
    ];
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
    return checks
        .map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`)
        .join('\n');
}

export async function runDoctor(dependencies: DoctorDependencies = {}): Promise<number> {
    const checks = await collectDoctorChecks(dependencies);
    console.log(formatDoctorReport(checks));
    const requiredChecks = checks.filter((check) => [
        'node',
        'ffmpeg',
        'yt-dlp',
        'dave-native',
        'voice-crypto',
    ].includes(check.name));
    const hasOpusEncoder = checks.some(
        (check) => (check.name === 'opus-native' || check.name === 'opus-fallback') && check.ok
    );
    return requiredChecks.every((check) => check.ok) && hasOpusEncoder ? 0 : 1;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (executedPath === resolve(fileURLToPath(import.meta.url))) {
    process.exitCode = await runDoctor();
}
