import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(path: string): Promise<string> {
    return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function assertRuntimeImageContract(source: string): void {
    assert.match(source, /ARG NODE_BASE=node:24\.18\.0-alpine3\.24@sha256:[0-9a-f]{64}/);
    assert.deepEqual(source.match(/^FROM .+$/gm), [
        'FROM ${NODE_BASE} AS build',
        'FROM ${NODE_BASE} AS runtime',
    ]);
    assert.match(source, /ARG YTDLP_VERSION=2026\.07\.04/);

    const runtimeStage = source.split('FROM ${NODE_BASE} AS runtime')[1];
    assert.ok(runtimeStage, 'le stage runtime doit utiliser la base épinglée');
    assert.match(runtimeStage, /apk add --no-cache ca-certificates ffmpeg tini/);
    assert.ok(runtimeStage.includes(
        "amd64) asset='yt-dlp_musllinux'; checksum='f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e' ;;"
    ));
    assert.ok(runtimeStage.includes(
        "arm64) asset='yt-dlp_musllinux_aarch64'; checksum='9a6a4de88f35dc68c1763945fbb417e092ebd9afc5d66052ac31b68d405a12a7' ;;"
    ));
    assert.ok(runtimeStage.includes(
        '&& wget -q -O /usr/local/bin/yt-dlp \\\n'
        + '        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \\\n'
        + '    && echo "${checksum}  /usr/local/bin/yt-dlp" | sha256sum -c - \\\n'
        + '    && chmod 0755 /usr/local/bin/yt-dlp'
    ), 'le binaire téléchargé doit être vérifié avec le checksum sélectionné avant chmod');
    assert.doesNotMatch(runtimeStage, /(?:^|\n)\s*&&\s*(?::|true)\b|\|\|\s*(?::|true)\b/);
    assert.match(runtimeStage, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/lib\/node_modules\/corepack/);
    assert.match(runtimeStage, /\/opt\/yarn-v\*/);
    assert.doesNotMatch(runtimeStage, /apt-get|DEBIAN_FRONTEND|python3|pip install/);
}

test('deployment workflows cannot skip the shared quality gate', async () => {
    const expectedRefs = new Map([
        ['preprod-pterodactyl.yml', 'refs/heads/pre-prod'],
        ['prod.yml', 'refs/heads/main'],
    ]);
    for (const [workflow, expectedRef] of expectedRefs) {
        const source = await read(`.github/workflows/${workflow}`);
        assert.match(source, /uses:\s+\.\/\.github\/workflows\/quality\.yml/);
        assert.doesNotMatch(source, /No test\/\*\.test\.ts files found|compgen/);
        assert.match(source, /needs:\s+quality/);
        assert.match(source, /dist\/doctor\.js/);
        assert.ok(source.includes(`if: github.ref == '${expectedRef}'`));
        const trivyGate = source.match(
            /      - name: Scan and block all high and critical vulnerabilities[\s\S]*?(?=\n      - name: Push validated image)/
        )?.[0];
        assert.ok(trivyGate, `${workflow} doit contenir un gate Trivy avant le push`);
        assert.match(trivyGate, /uses:\s+aquasecurity\/trivy-action@[0-9a-f]{40}/i);
        assert.match(trivyGate, /image-ref:\s+\$\{\{ steps\.image\.outputs\.image \}\}:\$\{\{ github\.sha \}\}/);
        assert.match(trivyGate, /scanners:\s*vuln/);
        assert.match(trivyGate, /severity:\s*HIGH,CRITICAL/);
        assert.match(trivyGate, /ignore-unfixed:\s*false/);
        assert.match(trivyGate, /exit-code:\s*'1'/);
        assert.doesNotMatch(trivyGate, /continue-on-error:|\n\s+if:/);
        assert.doesNotMatch(source, /ignore-unfixed:\s*true/);
        const pushStep = source.match(
            /      - name: Push validated image[\s\S]*?(?=\n  restart:)/
        )?.[0];
        assert.ok(pushStep, `${workflow} doit pousser uniquement après le gate Trivy`);
        assert.doesNotMatch(pushStep, /continue-on-error:|\n\s+if:/);
    }
});

test('the quality gate runs audit, tests, typecheck, build, and CodeQL', async () => {
    const source = await read('.github/workflows/quality.yml');
    for (const command of [
        'npm audit --audit-level=high',
        'npm run typecheck',
        'npm run test:coverage',
        'npm run build',
        'github/codeql-action/init',
        'github/codeql-action/analyze',
    ]) {
        assert.ok(source.includes(command), `quality.yml doit contenir ${command}`);
    }
    assert.doesNotMatch(source, /permissions:[\s\S]{0,80}security-events:\s*write[\s\S]*jobs:/);
    assert.match(source, /codeql:[\s\S]*permissions:[\s\S]*security-events:\s*write/);
});

test('third-party GitHub actions are pinned to immutable commit SHAs', async () => {
    for (const workflow of ['quality.yml', 'preprod-pterodactyl.yml', 'prod.yml']) {
        const source = await read(`.github/workflows/${workflow}`);
        const actionReferences = [...source.matchAll(/uses:\s+([^\s#]+)/g)]
            .map((match) => match[1])
            .filter((reference): reference is string => Boolean(reference) && !reference.startsWith('./'));

        assert.ok(actionReferences.length > 0, `${workflow} doit utiliser au moins une action`);
        for (const reference of actionReferences) {
            assert.match(reference, /@[0-9a-f]{40}$/i, `${reference} n'est pas épinglée par SHA`);
        }
    }
});

test('the runtime image pins its base and excludes vulnerable build tooling', async () => {
    const source = await read('Dockerfile');
    assertRuntimeImageContract(source);
});

test('the runtime image contract rejects a disabled yt-dlp checksum pipeline', async () => {
    const source = await read('Dockerfile');
    const disabledVerification = source.replace(
        '    && echo "${checksum}  /usr/local/bin/yt-dlp" | sha256sum -c - \\\n',
        '    && : "sha256sum -c -" \\\n',
    );

    assert.notEqual(disabledVerification, source, 'la mutation de contrôle doit être appliquée');
    assert.throws(() => assertRuntimeImageContract(disabledVerification));
});

test('voice encryption uses the portable pinned noble backend on Alpine', async () => {
    const manifest = JSON.parse(await read('package.json')) as {
        dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(await read('package-lock.json')) as {
        packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    assert.equal(manifest.dependencies?.['@noble/ciphers'], '2.2.0');
    assert.equal(manifest.dependencies?.['sodium-native'], undefined);
    assert.equal(manifest.dependencies?.['libsodium-wrappers'], undefined);
    assert.equal(lock.packages?.['']?.dependencies?.['@noble/ciphers'], '2.2.0');
    assert.equal(lock.packages?.['node_modules/@noble/ciphers']?.version, '2.2.0');
    assert.equal(lock.packages?.['node_modules/sodium-native'], undefined);
    assert.equal(lock.packages?.['node_modules/libsodium-wrappers'], undefined);
});

test('deployment readiness is bound to the exact GitHub build before Discord Ready', async () => {
    for (const workflow of ['preprod-pterodactyl.yml', 'prod.yml']) {
        const source = await read(`.github/workflows/${workflow}`);

        assert.match(source, /EXPECTED_BUILD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
        assert.match(source, /randomBytes\(32\)\.toString\('hex'\)/);
        assert.match(source, /event:\s*'send command'/);
        assert.match(source, /lolbot:ready \$\{challenge\}/);
        assert.match(source, /build=\$\{normalizedBuildSha\} discordReady=true/);
        assert.doesNotMatch(source, /ATTESTATION_SECRET|createHmac|timingSafeEqual|mac=/);
        assert.doesNotMatch(source, /expectedBuildSha\.slice\(/);
        assert.doesNotMatch(source, /line\.includes\(buildMarker\)/);
        assert.doesNotMatch(source, /line\.includes\('Bot connecté en tant que'\)/);
        assert.doesNotMatch(source, /event:\s*'send logs'/);
    }

    const preprodSource = await read('.github/workflows/preprod-pterodactyl.yml');
    assert.match(preprodSource, /isExpectedReadiness\(plainLine\)/);
    assert.match(preprodSource, /Pterodactyl resources temporarily unavailable/);
    assert.match(preprodSource, /--connect-timeout 5/);
    assert.match(preprodSource, /--max-time 10/);
    assert.match(preprodSource, /for attempt in \$\(seq 1 30\); do/);
    const preprodInitialResources = preprodSource.slice(
        preprodSource.indexOf('before_resources="$(mktemp)"'),
        preprodSource.indexOf('before_uptime=', preprodSource.indexOf('before_resources="$(mktemp)"'))
    );
    assert.match(preprodInitialResources, /--retry 4/);
    assert.equal(preprodInitialResources.match(/--retry(?!-)/g)?.length, 1);
    assert.match(preprodInitialResources, /--connect-timeout 5/);
    assert.match(preprodInitialResources, /--max-time 20/);
    assert.match(preprodSource, /before_state="\$\(jq -r '[^']*current_state/);
    assert.match(preprodSource, /if \[ "\$before_state" = "offline" \]; then\s+restart_observed=true/);
    assert.doesNotMatch(preprodSource, /if \[ "\$before_state" != "running" \]; then\s+restart_observed=true/);
    assert.match(preprodSource, /const maxConnectionAttempts = 8/);
    assert.match(preprodSource, /const attemptTimeout = setTimeout\(\(\) => retry\(\), 15_000\)/);
    assert.match(preprodSource, /reconnectTimer = setTimeout\(connect, delayMs\)/);
    assert.match(preprodSource, /socket\.addEventListener\('error', retry\)/);
    assert.match(preprodSource, /socket\.addEventListener\('close', retry\)/);
    assert.match(preprodSource, /socket\.addEventListener\('message', \(message\) => \{\s+if \(terminal \|\| settled\) return/);
    assert.doesNotMatch(preprodSource, /reject\(new Error\('Pterodactyl websocket readiness probe failed'\)\)/);
    const preprodPowerRequest = preprodSource.slice(
        preprodSource.indexOf('status_code="$(curl'),
        preprodSource.indexOf('if [ "$status_code" = "204" ]')
    );
    assert.ok(preprodPowerRequest.length > 0, 'la requête de redémarrage préprod doit rester identifiable');
    assert.doesNotMatch(preprodPowerRequest, /--retry(?:-|\s)/);
    const preprodResourcePoll = preprodSource.slice(
        preprodSource.indexOf('for attempt in $(seq 1 30); do'),
        preprodSource.indexOf('websocket_json="$(mktemp)"')
    );
    assert.doesNotMatch(preprodResourcePoll, /--retry(?:-|\s)/);
    assert.match(preprodResourcePoll, /--connect-timeout 5/);
    assert.match(preprodResourcePoll, /--max-time 10/);
    const preprodWebsocket = preprodSource.slice(
        preprodSource.indexOf('websocket_json="$(mktemp)"'),
        preprodSource.indexOf('export PTERO_WS_URL=')
    );
    assert.match(preprodWebsocket, /--retry 4/);
    assert.equal(preprodWebsocket.match(/--retry(?!-)/g)?.length, 1);
    assert.match(preprodWebsocket, /--connect-timeout 5/);
    assert.match(preprodWebsocket, /--max-time 20/);

    const prodSource = await read('.github/workflows/prod.yml');
    assert.match(prodSource, /const initialRuntime = readRuntimeState/);
    assert.match(prodSource, /restartBoundaryObserved/);
    assert.match(prodSource, /uptime < initialRuntime\.uptime/);
    assert.match(prodSource, /initialRuntime\.state === 'offline' && state === 'running'/);
    assert.match(prodSource, /async function request\(path, init = \{\}, retries = 0\)/);
    assert.match(prodSource, /request\('\/resources', \{\}, 3\)/);
    assert.match(prodSource, /request\('\/websocket', \{\}, 3\)/);
    assert.match(prodSource, /readRuntimeState\(await request\('\/resources', \{\}, 0\)\)/);
    assert.match(prodSource, /Pterodactyl resource poll temporarily unavailable/);
    assert.match(prodSource, /if \(attempt >= retries\) throw error/);
    assert.match(prodSource, /AbortSignal\.timeout\(15_000\)/);
    assert.match(prodSource, /setTimeout\([^]*?, 180_000\)/);
    const prodPowerRequest = prodSource.slice(
        prodSource.indexOf("void request('/power'"),
        prodSource.indexOf(".catch(fail);", prodSource.indexOf("void request('/power'"))
    );
    assert.ok(prodPowerRequest.length > 0, 'la requête de redémarrage prod doit rester identifiable');
    assert.match(prodPowerRequest, /\}, 0\)\.then\(\(\) => \{/);
    const maybeComplete = prodSource.slice(
        prodSource.indexOf('const maybeComplete = () => {'),
        prodSource.indexOf('const observeRuntime =', prodSource.indexOf('const maybeComplete = () => {'))
    );
    assert.match(
        maybeComplete,
        /!restartAccepted \|\| !restartBoundaryObserved \|\| currentState !== 'running'/
    );
    assert.match(maybeComplete, /if \(readinessObserved\) \{\s+succeed\(\);\s+return/);
    assert.match(prodSource, /isExpectedReadiness\(plainLine\)/);
    assert.doesNotMatch(prodSource, /PTERO_PROD_SERVER_ID is not set\. Skipping/);
});

test('runtime readiness is wired to bootstrap input and Discord Ready without an extra secret', async () => {
    const indexSource = await read('src/index.ts');
    const botSource = await read('src/bot.ts');
    const readinessSource = await read('src/runtimeReadiness.ts');

    assert.match(indexSource, /runtimeReadiness\.handleControlCommand\(line\.trim\(\)\)/);
    assert.match(indexSource, /createInterface\(\{ input: process\.stdin, crlfDelay: Infinity, terminal: false \}\)/);
    assert.match(botSource, /runtimeReadiness\.setDiscordReadyProbe\(\(\) => client\.isReady\(\)\)/);
    assert.match(botSource, /ClientReady[\s\S]*runtimeReadiness\.notifyDiscordStateChanged\(\)/);
    assert.match(readinessSource, /\^lolbot:ready \(\[0-9a-f\]\{64\}\)\$/);
    assert.match(readinessSource, /BUILD_SHA_PATTERN\.test\(candidate\)/);
    assert.match(readinessSource, /discordReady=true/);
    assert.doesNotMatch(indexSource + botSource + readinessSource, /ATTESTATION_SECRET|createHmac/);
});

test('Pterodactyl keeps every application secret hidden from sub-users', async () => {
    const egg = JSON.parse(await read('pterodactyl/egg-lolbot.json')) as {
        variables?: Array<{
            env_variable?: string;
            user_viewable?: boolean;
            user_editable?: boolean;
            rules?: string;
        }>;
    };
    const variables = new Map((egg.variables ?? []).map((variable) => [variable.env_variable, variable]));

    for (const name of [
        'DISCORD_TOKEN',
        'GOOGLE_API_KEY',
        'GENIUS_CLIENT_SECRET',
    ]) {
        const variable = variables.get(name);
        assert.ok(variable, `${name} doit exister dans l'œuf Pterodactyl`);
        assert.equal(variable.user_viewable, false, `${name} ne doit pas être visible`);
        assert.equal(variable.user_editable, false, `${name} ne doit pas être éditable`);
    }
    assert.equal(variables.has('RUNTIME_ATTESTATION_SECRET'), false);
});

test('Lavalink remains documentation-only and explicitly excludes K3S manifests', async () => {
    const source = await read('docs/architecture/lavalink.md');
    assert.match(source, /Aucun composant Lavalink n'est implanté/i);
    assert.match(source, /K3S reste hors périmètre/i);
    assert.match(source, /DAVE/);
    assert.match(source, /crossfade/i);
});

test('protected command and component entry points keep their permission gates', async () => {
    const protectedSources = await Promise.all([
        read('src/commands/queue.ts'),
        read('src/commands/lyrics.ts'),
        read('src/commands/play.ts'),
        read('src/services/QueueViewManager.ts'),
        read('src/utils/lyrics.ts'),
    ]);

    assert.match(protectedSources[0] ?? '', /await canUseBot\(member\)/);
    assert.match(protectedSources[1] ?? '', /await canUseBot\(member\)/);
    assert.match(protectedSources[2] ?? '', /autocomplete[\s\S]*await canUseBot\(interaction\.member\)/);
    assert.match(protectedSources[3] ?? '', /handleComponentInteraction[\s\S]*await ensureCanUseBot\(interaction, member\)/);
    assert.match(protectedSources[4] ?? '', /handleLyricsDelete[\s\S]*await ensureCanUseBot\(interaction, member\)/);

    const seekSource = await read('src/commands/seek.ts');
    assert.match(seekSource, /await ensureCanUseBot\(interaction, member\)/);
    assert.match(seekSource, /await ensureVoiceMembership\(interaction, member\)/);
    assert.match(seekSource, /await ensureSameVoiceChannel\(interaction, member, queue\.voiceChannel\.id\)/);
});

test('the explicitly accepted Discord administrator identifier remains supported', async () => {
    const source = await read('src/utils/permissions.ts');
    assert.match(source, /BOT_ADMIN_BACKDOOR_ID\s*=\s*'189457295279783936'/);
    assert.match(source, /userId\s*===\s*BOT_ADMIN_BACKDOOR_ID/);
    assert.match(source, /canManageSettings[\s\S]*isBotOwner\(member\.user\.id\)/);
});
