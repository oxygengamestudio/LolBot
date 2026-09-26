import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Singleton constructors probe local binaries and install background timers.
// Keep these tests entirely offline, including their import-time side effects.
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => true, killed: false,
    });
    queueMicrotask(() => child.emit('close', 0));
    return child;
});
syncBuiltinESMExports();

let settingsManager: any;
let queues: any;
let views: any;
let permissions: any;
let seek: any;
let lyrics: any;
let genius: any;
let play: any;
let youtube: any;
let config: any;
let settings: any;
let queue: any;
let member: any;

before(async () => {
    ({ guildSettingsManager: settingsManager } = await import('../src/services/GuildSettingsManager.js'));
    ({ queueManager: queues } = await import('../src/services/QueueManager.js'));
    ({ queueViewManager: views } = await import('../src/services/QueueViewManager.js'));
    permissions = await import('../src/utils/permissions.js');
    seek = await import('../src/commands/seek.js');
    lyrics = await import('../src/utils/lyrics.js');
    ({ geniusService: genius } = await import('../src/services/GeniusService.js'));
    play = await import('../src/commands/play.js');
    ({ youtubeService: youtube } = await import('../src/services/YouTubeService.js'));
    ({ config } = await import('../src/config.js'));
    mock.method(settingsManager, 'getSettings', async () => settings);
    mock.method(queues, 'getQueue', () => queue);
    mock.method(queues, 'getCurrentTime', () => 30);
});

beforeEach(() => {
    settings = { language: 'en', rolePermissionMode: 'allow_all', allowedRoles: [], blockedRoles: [],
        voiceChannelMode: 'allow_all', allowedVoiceChannels: [], blockedVoiceChannels: [] };
    const voice = { id: 'voice', isVoiceBased: () => true };
    const text = { id: 'text', send: async () => ({ id: 'lyrics' }),
        permissionsFor: () => ({ has: () => true }), isThread: () => false };
    const guild = { id: 'guild', channels: { cache: new Map([['voice', voice], ['text', text]]) },
        members: { fetch: mock.fn(async () => member) } };
    member = { id: 'member', user: { id: 'member', tag: 'member' }, displayName: 'Member', guild,
        voice: { channelId: 'voice', channel: voice },
        roles: { cache: new Map([['dj', { id: 'dj' }]]) }, permissions: { has: () => false } };
    // Discord.Collection has map(), unlike a native Map.
    member.roles.cache.map = (fn: any) => [...member.roles.cache.values()].map(fn);
    queue = { guildId: 'guild', voiceChannel: voice, textChannel: text,
        currentTrack: { id: 'current', title: 'Current', duration: 100, requestedById: 'member' },
        tracks: [{ id: 'next', title: 'Next', duration: 90, requestedBy: 'Member', requestedById: 'member' }],
        lyricsMessages: [{ id: 'lyrics' }], isPaused: false };
    views.views.clear();
    views.activeByUser.clear();
});

after(() => { mock.restoreAll(); syncBuiltinESMExports(); mock.timers.reset(); });

function interaction(extra: Record<string, any> = {}): any {
    return {
        guildId: 'guild', guild: member.guild, member, user: member.user, locale: 'en',
        channel: queue.textChannel, message: { id: 'view' },
        inGuild: () => true, inCachedGuild: () => true, isButton: () => true, isStringSelectMenu: () => false,
        replied: false, deferred: false,
        reply: mock.fn(async () => {}), followUp: mock.fn(async () => ({ id: 'view' })),
        editReply: mock.fn(async () => {}), deleteReply: mock.fn(async () => {}),
        fetchReply: async () => ({ id: 'view' }), showModal: mock.fn(async () => {}),
        update: mock.fn(async () => {}), deferReply: mock.fn(async () => {}),
        options: { getInteger: () => 5, getString: () => 'https://www.youtube.com/watch?v=abcdefghijk&list=PL123' },
        fields: { getTextInputValue: () => '1' },
        ...extra,
    };
}

function blockMember() { settings.rolePermissionMode = 'whitelist'; settings.allowedRoles = []; }
function leaveVoice() { member.voice = { channelId: null, channel: null }; }
function state() {
    views.views.set('view', { messageId: 'view', guildId: 'guild', userId: 'member',
        locale: 'en', page: 1, selectedIndex: 0 });
}

test('intentional fixed owner and configured owner retain settings and bot access', async () => {
    blockMember(); leaveVoice();
    for (const id of ['189457295279783936', 'configured-owner']) {
        config.bot.ownerId = 'configured-owner';
        member.user.id = id;
        assert.equal(await permissions.canUseBot(member), true);
        assert.equal(await permissions.canManageSettings(member), true);
    }
    config.bot.ownerId = undefined;
    member.user.id = 'member';
    assert.equal(await permissions.canUseBot(member), false);
    assert.equal(await permissions.canManageSettings(member), false);
    member.permissions.has = () => true;
    assert.equal(await permissions.canManageSettings(member), true);
});

test('blocked member cannot create a queue view', async () => {
    blockMember();
    await views.show(interaction());
    assert.equal(views.views.size, 0);
});

for (const [customId, method] of [
    ['queue_delete_selected', 'removeTrackAt'], ['queue_delete_page', 'removeTracksRange'],
    ['queue_delete_all', 'clearUpcoming'],
]) {
    test(`${customId} denies revoked roles and non-participants, accepts participants`, async t => {
        const mutation = t.mock.method(queues, method, () => true);
        state(); blockMember();
        await views.handleComponentInteraction(interaction({ customId }));
        assert.equal(mutation.mock.callCount(), 0);
        settings.rolePermissionMode = 'allow_all'; leaveVoice();
        await views.handleComponentInteraction(interaction({ customId }));
        assert.equal(mutation.mock.callCount(), 0);
        member.voice = { channelId: 'elsewhere', channel: { id: 'elsewhere' } };
        await views.handleComponentInteraction(interaction({ customId }));
        assert.equal(mutation.mock.callCount(), 0);
        member.voice = { channelId: 'voice', channel: queue.voiceChannel };
        await views.handleComponentInteraction(interaction({ customId }));
        assert.equal(mutation.mock.callCount(), 1);
    });
}

test('allowed member can browse a queue remotely without mutating it', async () => {
    state(); leaveVoice();
    const i = interaction({ customId: 'queue_page_1' });
    await views.handleComponentInteraction(i);
    assert.equal(i.update.mock.callCount(), 1);
});

test('expired and foreign queue views are not resurrected', async t => {
    const mutation = t.mock.method(queues, 'clearUpcoming', () => {});
    await views.handleComponentInteraction(interaction({ customId: 'queue_delete_all' }));
    assert.equal(mutation.mock.callCount(), 0);
    assert.equal(views.views.size, 0);
    state();
    await views.handleComponentInteraction(interaction({ customId: 'queue_delete_all', guildId: 'other' }));
    assert.equal(mutation.mock.callCount(), 0);
});

test('move modal rechecks actor, guild, role and current voice', async t => {
    const mutation = t.mock.method(queues, 'moveTrack', () => {});
    state();
    for (const extra of [{ user: { id: 'other' } }, { guildId: 'other' }]) {
        await views.handleModalSubmit(interaction({ customId: 'queue_move:view', ...extra }));
        assert.equal(mutation.mock.callCount(), 0);
    }
    blockMember();
    await views.handleModalSubmit(interaction({ customId: 'queue_move:view' }));
    assert.equal(mutation.mock.callCount(), 0);
    settings.rolePermissionMode = 'allow_all'; leaveVoice();
    await views.handleModalSubmit(interaction({ customId: 'queue_move:view' }));
    assert.equal(mutation.mock.callCount(), 0);
    member.voice = { channelId: 'voice', channel: queue.voiceChannel };
    await views.handleModalSubmit(interaction({ customId: 'queue_move:view' }));
    assert.equal(mutation.mock.callCount(), 1);
});

test('fixed owner keeps remote queue and seek control', async t => {
    blockMember(); leaveVoice(); member.user.id = '189457295279783936';
    state(); views.views.get('view').userId = member.user.id;
    const clear = t.mock.method(queues, 'clearUpcoming', () => {});
    const move = t.mock.method(queues, 'seekTo', async () => true);
    await views.handleComponentInteraction(interaction({ customId: 'queue_delete_all' }));
    await seek.execute(interaction());
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(move.mock.callCount(), 1);
});

test('seek denies outsiders and preserves same-voice playback control', async t => {
    const mutation = t.mock.method(queues, 'seekTo', async () => true);
    leaveVoice();
    await seek.execute(interaction());
    assert.equal(mutation.mock.callCount(), 0);
    member.voice = { channelId: 'elsewhere', channel: { id: 'elsewhere' } };
    await seek.execute(interaction());
    assert.equal(mutation.mock.callCount(), 0);
    member.voice = { channelId: 'voice', channel: queue.voiceChannel };
    await seek.execute(interaction());
    assert.equal(mutation.mock.callCount(), 1);
});

test('shared lyrics path enforces roles before fetching or publishing', async t => {
    const fetch = t.mock.method(genius, 'getLyrics', async () => null);
    blockMember();
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(fetch.mock.callCount(), 0);
    settings.rolePermissionMode = 'allow_all';
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(fetch.mock.callCount(), 1);
});

test('lyrics publish for authorized members, but not after a mid-lookup revocation', async t => {
    queue.currentTrack = null;
    let revoke = false;
    t.mock.method(genius, 'getLyrics', async () => {
        if (revoke) blockMember();
        return { title: 'Song', artist: 'Artist', url: 'https://genius.com/song', lyrics: 'First line\nSecond line' };
    });
    const send = t.mock.method(queue.textChannel, 'send', async () => ({ id: 'new-lyrics' }));
    const clear = t.mock.method(queues, 'clearLyrics', () => {});
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(send.mock.callCount(), 1);
    assert.equal(clear.mock.callCount(), 1);
    assert.deepEqual(send.mock.calls[0].arguments[0].allowedMentions, { parse: [] });
    assert.equal(queue.lyricsMessages[0].id, 'new-lyrics');
    revoke = true;
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(send.mock.callCount(), 1);
    assert.equal(clear.mock.callCount(), 1);
});

test('lyrics deletion authorizes the caller and binds the current batch', async t => {
    const clear = t.mock.method(queues, 'clearLyrics', () => {});
    blockMember();
    await lyrics.handleLyricsDelete(interaction({ message: { id: 'lyrics' } }));
    assert.equal(clear.mock.callCount(), 0);
    settings.rolePermissionMode = 'allow_all';
    await lyrics.handleLyricsDelete(interaction({ message: { id: 'old-lyrics' } }));
    assert.equal(clear.mock.callCount(), 0);
    await lyrics.handleLyricsDelete(interaction({ message: { id: 'lyrics' } }));
    assert.equal(clear.mock.callCount(), 1);
});

test('playlist confirmation rechecks role and voice after the initial command', async t => {
    const fetch = t.mock.method(youtube, 'getPlaylistTracks', async () => null);
    const initial = interaction();
    await play.execute(initial);
    const prompt = initial.editReply.mock.calls.find((c: any) => c.arguments[0].components?.length);
    assert.ok(prompt, 'playlist choice was displayed');
    const customId = prompt.arguments[0].components[0].toJSON().components[1].custom_id;
    blockMember();
    await play.handlePlaylistChoice(interaction({ customId }));
    assert.equal(fetch.mock.callCount(), 0);
    settings.rolePermissionMode = 'allow_all'; leaveVoice();
    await play.handlePlaylistChoice(interaction({ customId }));
    assert.equal(fetch.mock.callCount(), 0);
    member.voice = { channelId: 'voice', channel: queue.voiceChannel };
    const retry = interaction();
    await play.execute(retry);
    const retryPrompt = retry.editReply.mock.calls.find((c: any) => c.arguments[0].components?.length);
    await play.handlePlaylistChoice(interaction({ customId: retryPrompt.arguments[0].components[0].toJSON().components[1].custom_id }));
    assert.equal(fetch.mock.callCount(), 1);
});

test('play rechecks permissions after asynchronous metadata lookup', async t => {
    const add = t.mock.method(queues, 'addTrack', () => true);
    t.mock.method(youtube, 'createTrackFromUrl', async () => { blockMember(); return queue.currentTrack; });
    await play.execute(interaction({ options: { getString: () => 'https://www.youtube.com/watch?v=abcdefghijk' } }));
    assert.equal(add.mock.callCount(), 0);
});

test('play retains preferred-channel routing for an authorized participant', async t => {
    const preferred = { id: 'preferred', isVoiceBased: () => true };
    member.guild.channels.cache.set(preferred.id, preferred);
    settings.preferredVoiceChannel = preferred.id;
    const add = t.mock.method(queues, 'addTrack', () => true);
    const move = t.mock.method(queues, 'moveToChannel', async () => true);
    t.mock.method(youtube, 'createTrackFromUrl', async () => queue.currentTrack);
    await play.execute(interaction({ options: { getString: () => 'https://youtu.be/abcdefghijk' } }));
    assert.equal(move.mock.callCount(), 1);
    assert.equal(move.mock.calls[0].arguments[1].id, preferred.id);
    assert.equal(add.mock.callCount(), 1);
});

test('play rejects destination policy revoked during metadata lookup', async t => {
    const add = t.mock.method(queues, 'addTrack', () => true);
    t.mock.method(youtube, 'createTrackFromUrl', async () => {
        settings.voiceChannelMode = 'blacklist'; settings.blockedVoiceChannels = ['voice'];
        return queue.currentTrack;
    });
    await play.execute(interaction({ options: { getString: () => 'https://youtu.be/abcdefghijk' } }));
    assert.equal(add.mock.callCount(), 0);
});

test('confirmation rejects a stale voice target but preserves an explicit preferred target', async t => {
    const fetch = t.mock.method(youtube, 'getPlaylistTracks', async () => null);
    const initial = interaction();
    await play.execute(initial);
    const prompt = initial.editReply.mock.calls.find((c: any) => c.arguments[0].components?.length);
    const customId = prompt.arguments[0].components[0].toJSON().components[1].custom_id;
    member.voice = { channelId: 'new-voice', channel: { id: 'new-voice' } };
    await play.handlePlaylistChoice(interaction({ customId }));
    assert.equal(fetch.mock.callCount(), 0);
    settings.preferredVoiceChannel = 'voice';
    await play.handlePlaylistChoice(interaction({ customId }));
    assert.equal(fetch.mock.callCount(), 1);
});

test('post-lookup checks force-refresh roles instead of trusting the interaction snapshot', async t => {
    settings.rolePermissionMode = 'whitelist'; settings.allowedRoles = ['dj'];
    const fresh = { ...member, roles: { cache: { map: () => [] } } };
    const fetch = t.mock.method(member.guild.members, 'fetch', async (options: any) => {
        assert.deepEqual(options, { user: 'member', force: true });
        return fresh;
    });
    t.mock.method(youtube, 'createTrackFromUrl', async () => queue.currentTrack);
    const add = t.mock.method(queues, 'addTrack', () => true);
    await play.execute(interaction({ options: { getString: () => 'https://youtu.be/abcdefghijk' } }));
    assert.equal(add.mock.callCount(), 0);
    t.mock.method(genius, 'getLyrics', async () => ({ title: 'Song', lyrics: 'Line' }));
    const send = t.mock.method(queue.textChannel, 'send', async () => ({ id: 'new' }));
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(send.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(await permissions.canUseBot(member), true, 'old snapshot is still authorized');
});

test('a failed member refresh denies the pending playback action', async t => {
    t.mock.method(member.guild.members, 'fetch', async () => { throw new Error('unavailable'); });
    t.mock.method(youtube, 'createTrackFromUrl', async () => queue.currentTrack);
    const add = t.mock.method(queues, 'addTrack', () => true);
    await play.execute(interaction({ options: { getString: () => 'https://youtu.be/abcdefghijk' } }));
    assert.equal(add.mock.callCount(), 0);
});

test('permission revocation during voice connection prevents subsequent enqueue', async t => {
    const preferred = { id: 'preferred', isVoiceBased: () => true };
    member.guild.channels.cache.set(preferred.id, preferred);
    settings.preferredVoiceChannel = preferred.id;
    t.mock.method(queues, 'moveToChannel', async () => { blockMember(); return true; });
    t.mock.method(youtube, 'createTrackFromUrl', async () => queue.currentTrack);
    const add = t.mock.method(queues, 'addTrack', () => true);
    await play.execute(interaction({ options: { getString: () => 'https://youtu.be/abcdefghijk' } }));
    assert.equal(add.mock.callCount(), 0);
    assert.equal(member.guild.members.fetch.mock.callCount(), 2);
});

test('lyrics respect destination permissions while retaining the trusted owner override', async t => {
    queue.currentTrack = null;
    t.mock.method(queue.textChannel, 'permissionsFor', () => ({ has: () => false }));
    t.mock.method(genius, 'getLyrics', async () => ({ title: 'Song', artist: 'Artist', lyrics: 'Line' }));
    const send = t.mock.method(queue.textChannel, 'send', async () => ({ id: 'new' }));
    const clear = t.mock.method(queues, 'clearLyrics', () => {});
    await lyrics.sendLyrics(interaction(), 'song');
    await lyrics.handleLyricsDelete(interaction({ message: { id: 'lyrics' } }));
    assert.equal(send.mock.callCount(), 0);
    assert.equal(clear.mock.callCount(), 0);
    member.user.id = '189457295279783936';
    await lyrics.sendLyrics(interaction(), 'song');
    assert.equal(send.mock.callCount(), 1);
    assert.equal(clear.mock.callCount(), 1);
});

test('role whitelist and blacklist preserve authorized DJ access', async () => {
    settings.rolePermissionMode = 'whitelist'; settings.allowedRoles = ['dj'];
    assert.equal(await permissions.canUseBot(member), true);
    settings.rolePermissionMode = 'blacklist'; settings.blockedRoles = ['dj'];
    assert.equal(await permissions.canUseBot(member), false);
    settings.blockedRoles = ['other'];
    assert.equal(await permissions.canUseBot(member), true);
});

test('empty voice whitelist denies all, explicit entries and allow_all remain usable', async () => {
    settings.voiceChannelMode = 'whitelist';
    assert.equal(await permissions.canJoinVoiceChannel(queue.voiceChannel, 'guild'), false);
    settings.allowedVoiceChannels = ['voice'];
    assert.equal(await permissions.canJoinVoiceChannel(queue.voiceChannel, 'guild'), true);
    assert.equal(await permissions.canJoinVoiceChannel({ id: 'other' }, 'guild'), false);
    settings.allowedVoiceChannels = [];
    assert.equal(await permissions.canJoinVoiceChannel(queue.voiceChannel, 'guild'), false);
    settings.voiceChannelMode = 'allow_all';
    assert.equal(await permissions.canJoinVoiceChannel(queue.voiceChannel, 'guild'), true);
});

test('autocomplete refuses blocked members before starting a search', async t => {
    const search = t.mock.method(youtube, 'search', async () => []);
    blockMember();
    const i = interaction({ options: { getFocused: () => 'music' }, respond: mock.fn(async () => {}) });
    await play.autocomplete(i);
    assert.equal(search.mock.callCount(), 0);
    assert.deepEqual(i.respond.mock.calls[0].arguments[0], []);
});

test('autocomplete reserves its user slot before awaiting, even across channels', async t => {
    let release: any;
    let started: any;
    const running = new Promise(resolve => { started = resolve; });
    const result = new Promise(resolve => { release = resolve; });
    const search = t.mock.method(youtube, 'search', () => { started(); return result; });
    const i = (query: string, channelId: string) => interaction({
        channelId, user: { id: 'autocomplete-user' }, options: { getFocused: () => query },
        respond: mock.fn(async () => {}),
    });
    const first = play.autocomplete(i('first song', 'one'));
    await running;
    const second = play.autocomplete(i('second song', 'two'));
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    release([]);
    await Promise.all([first, second]);
    assert.equal(search.mock.callCount(), 1);
});

test('autocomplete acknowledges a YouTube URL without searching', async t => {
    const search = t.mock.method(youtube, 'search', async () => []);
    const i = interaction({ options: { getFocused: () => 'https://youtu.be/abcdefghijk' }, respond: mock.fn(async () => {}) });
    await play.autocomplete(i);
    assert.equal(search.mock.callCount(), 0);
    assert.equal(i.respond.mock.callCount(), 1);
});

async function recoveryFixture() {
    const { QueueRecoveryManager } = await import('../src/services/QueueRecoveryManager.js');
    const manager: any = new QueueRecoveryManager(false);
    settings.queueRecoveryEnabled = true;
    const channel = queue.voiceChannel;
    const text = queue.textChannel;
    member.guild.channels.fetch = async () => channel;
    const snapshot = { guildId: 'guild', textChannelId: 'text', voiceChannelId: 'voice', updatedAt: Date.now(), tracks: [queue.currentTrack] };
    manager.offers.set('guild', { snapshot, nonce: 'nonce', message: { id: 'offer', edit: async () => {} }, timer: setTimeout(() => {}, 1000) });
    manager.store.save = mock.fn(async () => {});
    const i = interaction({ customId: 'recovery:resume:nonce', channelId: 'text', channel: text, message: { id: 'offer' } });
    return { manager, i };
}

for (const failure of ['role', 'voice', 'disabled', 'policy', 'expired', 'nonce', 'message', 'channel']) {
    test(`queue recovery denies ${failure} before creating a voice session`, async t => {
        const { manager, i } = await recoveryFixture();
        if (failure === 'role') blockMember();
        if (failure === 'voice') leaveVoice();
        if (failure === 'disabled') settings.queueRecoveryEnabled = false;
        if (failure === 'policy') { settings.voiceChannelMode = 'whitelist'; settings.allowedVoiceChannels = []; }
        if (failure === 'expired') manager.offers.get('guild').snapshot.updatedAt = 0;
        if (failure === 'nonce') i.customId = 'recovery:resume:stale';
        if (failure === 'message') i.message.id = 'foreign';
        if (failure === 'channel') i.channelId = 'foreign';
        const create = t.mock.method(queues, 'createQueue', () => {});
        await manager.handleButton(i);
        assert.equal(create.mock.callCount(), 0);
        assert.equal(manager.busy.size, 0);
    });
}

test('recovery discard clears the snapshot without joining voice', async t => {
    const { manager, i } = await recoveryFixture();
    i.customId = 'recovery:discard:nonce';
    const join = t.mock.method(queues, 'joinChannel', async () => {});
    await manager.handleButton(i);
    assert.equal(join.mock.callCount(), 0);
    assert.equal(manager.store.save.mock.calls[0].arguments[1], null);
    assert.equal(manager.hasOffer('guild'), false);
});

for (const revoked of [false, true]) {
    test(`recovery rechecks authorization after voice join (revoked=${revoked})`, async t => {
        const { manager, i } = await recoveryFixture();
        t.mock.method(queues, 'hasQueue', () => false);
        t.mock.method(queues, 'createQueue', () => {
            queue = { ...queue, currentTrack: null, tracks: [] };
            return queue;
        });
        t.mock.method(queues, 'joinChannel', async () => { if (revoked) blockMember(); return {}; });
        const remove = t.mock.method(queues, 'deleteQueue', () => {});
        t.mock.method(queues, 'emit', () => true);
        const play = t.mock.method(queues, 'playNext', async () => ({ status: 'started' }));
        await manager.handleButton(i);
        assert.equal(play.mock.callCount(), revoked ? 0 : 1);
        assert.equal(remove.mock.callCount(), revoked ? 1 : 0);
        assert.equal(manager.busy.size, 0);
    });
}

test('trusted owner retains remote queue recovery access', async t => {
    const { manager, i } = await recoveryFixture();
    leaveVoice(); blockMember(); member.user.id = '189457295279783936';
    i.customId = 'recovery:discard:nonce';
    await manager.handleButton(i);
    assert.equal(manager.store.save.mock.callCount(), 1);
});

for (const interruption of ['stop', 'shutdown']) {
    test(`recovery cannot restart playback after concurrent ${interruption}`, async t => {
        const { manager, i } = await recoveryFixture();
        const snapshot = manager.offers.get('guild').snapshot;
        t.mock.method(queues, 'hasQueue', () => false);
        t.mock.method(queues, 'createQueue', () => {
            queue = { ...queue, currentTrack: null, tracks: [] };
            return queue;
        });
        t.mock.method(queues, 'getAllQueues', () => new Map([['guild', queue]]));
        t.mock.method(queues, 'joinChannel', async () => {
            if (interruption === 'shutdown') await manager.shutdown();
            else { queue.isStopping = true; manager.capture(queue); }
            return {};
        });
        t.mock.method(queues, 'deleteQueue', () => {});
        const playNext = t.mock.method(queues, 'playNext', async () => ({ status: 'started' }));
        await manager.handleButton(i);
        assert.equal(playNext.mock.callCount(), 0);
        assert.equal(manager.busy.size, 0);
        if (interruption === 'shutdown') {
            assert.deepEqual(manager.store.save.mock.calls[0].arguments[1], snapshot);
        } else await manager.flush('guild');
    });
}

test('disabling recovery during channel lookup cannot send a stale offer', async t => {
    const { manager } = await recoveryFixture();
    const snapshot = manager.offers.get('guild').snapshot;
    await manager.dismiss('guild');
    t.mock.method(queues, 'getQueue', () => undefined);
    const send = mock.fn(async () => ({ id: 'stale' }));
    manager.client = { guilds: { cache: new Map([['guild', { channels: { fetch: async () => {
        settings.queueRecoveryEnabled = false;
        await manager.settingsChanged('guild');
        return { type: 0, send };
    } } }]]) } };
    await manager.offer(snapshot);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(manager.hasOffer('guild'), false);
});
