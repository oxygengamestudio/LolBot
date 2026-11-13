import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearStaleGuildCommands } from '../src/utils/commandCleanup.js';

test('stale guild commands are removed only where some exist, and one failing guild does not stop the rest', async () => {
    const existing: Record<string, unknown[]> = {
        'guild-with-old-commands': [{ name: 'play' }, { name: 'seek' }],
        'guild-clean': [],
        'guild-after-failure': [{ name: 'stats' }],
    };
    const puts: Array<{ route: string; body: unknown }> = [];
    const rest = {
        get: async (route: string) => {
            const guildId = route.slice('/guilds/'.length);
            if (guildId === 'guild-no-access') throw new Error('Missing Access');
            return existing[guildId];
        },
        put: async (route: string, options: { body: unknown }) => {
            puts.push({ route, body: options.body });
            return [];
        },
    };

    const result = await clearStaleGuildCommands(
        rest,
        (guildId) => `/guilds/${guildId}`,
        ['guild-with-old-commands', 'guild-clean', 'guild-no-access', 'guild-after-failure']
    );

    assert.deepEqual(result, {
        cleaned: ['guild-with-old-commands', 'guild-after-failure'],
        failed: ['guild-no-access'],
    });
    assert.deepEqual(puts, [
        { route: '/guilds/guild-with-old-commands', body: [] },
        { route: '/guilds/guild-after-failure', body: [] },
    ]);
});
