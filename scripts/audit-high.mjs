import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ALLOWED_BACKPORT = 'GHSA-mh99-v99m-4gvg';
const PATCHED_BRACE_VERSION = '1.1.18';
const npmCli = process.argv[2] || process.env.npm_execpath;

if (!npmCli) {
    console.error('npm_execpath is unavailable; run through npm or pass the npm CLI path explicitly.');
    process.exit(1);
}

const audit = spawnSync(process.execPath, [npmCli, 'audit', '--json', '--audit-level=high'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
});

if (audit.status === 0) {
    process.stdout.write(audit.stdout);
    process.exit(0);
}

let report;
try {
    report = JSON.parse(audit.stdout);
} catch {
    process.stderr.write(audit.stderr || audit.stdout || 'npm audit failed without JSON output.\n');
    process.exit(1);
}

if (audit.status !== 1 || report.error || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    process.stderr.write(audit.stderr || audit.stdout || 'npm audit did not return a vulnerability report.\n');
    process.exit(1);
}

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const lockedBraceVersion = lock.packages?.['node_modules/brace-expansion']?.version;
if (lockedBraceVersion !== PATCHED_BRACE_VERSION) {
    console.error(`Refusing the audit exception: brace-expansion ${lockedBraceVersion ?? 'missing'} is not ${PATCHED_BRACE_VERSION}.`);
    process.exit(1);
}

const require = createRequire(import.meta.url);
const braceSource = readFileSync(require.resolve('brace-expansion'), 'utf8');
if (!braceSource.includes('EXPANSION_MAX_LENGTH') || !braceSource.includes('CVE-2026-14257')) {
    console.error('Refusing the audit exception: the installed brace-expansion backport lacks the bounded-output fix.');
    process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const severe = new Set(
    Object.entries(vulnerabilities)
        .filter(([, finding]) => finding?.severity === 'high' || finding?.severity === 'critical')
        .map(([name]) => name)
);

function severeAdvisories(name, seen = new Set()) {
    if (seen.has(name)) return new Set();
    seen.add(name);
    const finding = vulnerabilities[name];
    if (!finding) return new Set();

    const ids = new Set();
    for (const cause of finding.via ?? []) {
        if (typeof cause === 'string') {
            for (const id of severeAdvisories(cause, seen)) ids.add(id);
            continue;
        }
        if (cause?.severity !== 'high' && cause?.severity !== 'critical') continue;
        const match = String(cause.url ?? '').match(/GHSA-[a-z0-9-]+/i);
        ids.add(match?.[0]?.toUpperCase() ?? `UNKNOWN:${name}`);
    }
    return ids;
}

const unexplained = [];
let allowedBackportObserved = false;
for (const name of severe) {
    const ids = severeAdvisories(name);
    if (ids.has(ALLOWED_BACKPORT.toUpperCase())) allowedBackportObserved = true;
    if (ids.size === 0 || [...ids].some((id) => id !== ALLOWED_BACKPORT.toUpperCase())) {
        unexplained.push(`${name} (${[...ids].join(', ') || 'no advisory id'})`);
    }
}

if (!allowedBackportObserved || unexplained.length > 0) {
    process.stderr.write(audit.stdout);
    console.error(`Blocking HIGH/CRITICAL audit findings: ${unexplained.join('; ') || 'expected backport advisory not found'}`);
    process.exit(1);
}

console.warn(
    `npm audit reports ${ALLOWED_BACKPORT}, but brace-expansion ${PATCHED_BRACE_VERSION} contains the verified maintenance backport; no other HIGH/CRITICAL advisory is present.`
);
