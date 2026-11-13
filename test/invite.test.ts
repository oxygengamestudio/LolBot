import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the invite link targets this application with the playback permissions and both scopes', async () => {
    const { getInviteLink } = await import('../src/utils/invite.js');
    const { config } = await import('../src/config.js');
    const url = new URL(getInviteLink());

    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), config.discord.clientId);
    // Voir les salons, envoyer des messages, liens intégrés, historique, connexion, parole,
    // détection vocale, commandes : ni administrateur, ni gestion du serveur.
    assert.equal(url.searchParams.get('permissions'), '2184268800');
    assert.equal(BigInt(url.searchParams.get('permissions')!) & 8n, 0n, 'jamais la permission Administrateur');
    assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
});

test('/invite is registered as a guild-only command gated like the others', async () => {
    const { commands } = await import('../src/commands/index.js');
    const invite = commands.find((command) => command.data.name === 'invite');
    assert.ok(invite, 'la commande doit être enregistrée');
    assert.equal(invite.data.toJSON().dm_permission, false);

    const denied: string[] = [];
    await invite.execute({
        inGuild: () => false,
        locale: 'fr',
        deferred: false,
        replied: false,
        reply: async (payload: { content: string }) => { denied.push(payload.content); },
    } as never);
    assert.equal(denied.length, 1, 'hors serveur, la commande refuse sans donner de lien');
    assert.doesNotMatch(denied[0]!, /discord\.com/);
});
