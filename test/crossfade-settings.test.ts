import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildSettingsManager, MAX_CROSSFADE_SECONDS } from '../src/services/GuildSettingsManager.js';
import { buildSettingsMessage, buildSettingsModal, parseSettingsModalId, SETTINGS_BUTTON_IDS } from '../src/utils/settings-ui.js';

const guild = '123456789012345678';

test('crossfade duration is clamped, persisted, and never enabled by the legacy flag alone', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lolbot-crossfade-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const manager = new GuildSettingsManager(dir, dir);

    const defaults = await manager.getSettings(guild);
    assert.equal(defaults.crossfadeSeconds, 0);
    assert.equal(defaults.crossfadeEnabled, false);

    assert.equal((await manager.updateSettings(guild, { crossfadeEnabled: true })).crossfadeSeconds, 0);
    assert.equal((await manager.updateSettings(guild, { crossfadeSeconds: 99 })).crossfadeSeconds, MAX_CROSSFADE_SECONDS);
    assert.equal((await manager.updateSettings(guild, { crossfadeSeconds: -3 })).crossfadeSeconds, 0);

    const updated = await manager.updateSettings(guild, { crossfadeSeconds: 6 });
    assert.equal(updated.crossfadeSeconds, 6);
    assert.equal(updated.crossfadeEnabled, true);
});

test('the settings panel shows the crossfade duration and opens its own modal', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lolbot-crossfade-ui-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const manager = new GuildSettingsManager(dir, dir);
    const settings = await manager.updateSettings(guild, { crossfadeSeconds: 8, locale: 'fr' });

    const message = buildSettingsMessage(settings);
    assert.match(message.embeds[0]!.data.description ?? '', /Fondu enchaîné: 8 s/);
    const buttonIds = message.components.flatMap((row) => row.components.map((button) => (button.data as { custom_id?: string }).custom_id));
    assert.ok(buttonIds.includes(SETTINGS_BUTTON_IDS.crossfade));

    const off = buildSettingsMessage({ ...settings, crossfadeSeconds: 0 });
    assert.match(off.embeds[0]!.data.description ?? '', /Fondu enchaîné: Désactivé \(gapless\)/);

    const modal = buildSettingsModal('crossfade', settings, '111111111111111111');
    assert.deepEqual(parseSettingsModalId(modal.data.custom_id!), { kind: 'crossfade', messageId: '111111111111111111' });
    assert.match(JSON.stringify(modal.toJSON()), /"value":"8"/);
});
