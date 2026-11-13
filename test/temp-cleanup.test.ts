import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('startup cleanup removes every leftover run directory and fragment, whatever its age', async () => {
    const { audioWrapper } = await import('../src/audio/AudioWrapper.js');
    const wrapper = audioWrapper as any;
    const guildDir = wrapper.getGuildCacheDir('guild-temp-startup');
    const runDir = join(guildDir, 'run-123-abcdef');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'audio.part'), 'partial download');
    await writeFile(join(guildDir, '--Frag12'), 'fragment');

    await wrapper.cleanupAllStaleTemp(); // passe périodique : un dossier récent est peut-être en cours d'utilisation
    assert.equal(existsSync(runDir), true, 'un dossier de lecture récent est conservé');

    await wrapper.cleanupAllStaleTemp(0); // passe du démarrage : plus rien n'est en cours
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(join(guildDir, '--Frag12')), false);
});

test('ending a guild session wipes its temp folder and its in-memory playback state', async () => {
    const { audioWrapper } = await import('../src/audio/AudioWrapper.js');
    const wrapper = audioWrapper as any;
    const guildId = 'guild-temp-session';
    const guildDir = wrapper.getGuildCacheDir(guildId);
    const runDir = join(guildDir, 'run-456-fedcba');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'leftover.webm'), 'audio');
    wrapper.cache.set(`${guildId}:track`, { guildId, trackId: 'track', resource: null, streamUrl: 'x', timestamp: Date.now() });
    wrapper.warmTracks.set(`${guildId}:track`, { warmedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    wrapper.crossfadeSecondsByGuild.set(guildId, 5);
    audioWrapper.markDirectStreamUnreliable(guildId, 'track');
    audioWrapper.markDirectStreamUnreliable('other-guild', 'track');

    await audioWrapper.cleanupGuildTemp(guildId);

    assert.equal(existsSync(runDir), false, 'les fichiers temporaires de la guilde sont supprimés');
    assert.equal(existsSync(guildDir), true, 'le dossier vide est recréé pour la prochaine lecture');
    assert.equal(wrapper.cache.has(`${guildId}:track`), false);
    assert.equal(wrapper.warmTracks.has(`${guildId}:track`), false);
    assert.equal(wrapper.crossfadeSecondsByGuild.has(guildId), false);
    assert.equal(wrapper.unreliableDirectStreams.has(`${guildId}:track`), false);
    assert.equal(wrapper.unreliableDirectStreams.has('other-guild:track'), true, 'les autres guildes ne sont pas touchées');
    wrapper.unreliableDirectStreams.clear();
});
