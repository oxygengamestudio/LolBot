import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDataDir = join(tmpdir(), `lolbot-permissions-${process.pid}`);
process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '123456789012345678';
process.env.DATA_DIR = testDataDir;

type Settings = {
    guildId: string;
    locale: 'fr' | 'en';
    volume: number;
    stayConnected: boolean;
    stayConnectedAlways: boolean;
    pauseOnEmptyChannelWhenAlwaysConnected: boolean;
    crossfadeEnabled: boolean;
    sponsorBlockEnabled: boolean;
    preferredVoiceChannel: string | null;
    voiceChannelMode: 'allow_all' | 'whitelist' | 'blacklist';
    allowedVoiceChannels: string[];
    blockedVoiceChannels: string[];
    rolePermissionMode: 'allow_all' | 'whitelist' | 'blacklist';
    allowedRoles: string[];
    blockedRoles: string[];
};

const deniedSettings: Settings = {
    guildId: 'guild-permissions',
    locale: 'fr',
    volume: 100,
    stayConnected: false,
    stayConnectedAlways: false,
    pauseOnEmptyChannelWhenAlwaysConnected: false,
    crossfadeEnabled: false,
    sponsorBlockEnabled: false,
    preferredVoiceChannel: null,
    voiceChannelMode: 'allow_all',
    allowedVoiceChannels: [],
    blockedVoiceChannels: [],
    rolePermissionMode: 'whitelist',
    allowedRoles: ['allowed-role'],
    blockedRoles: [],
};

let modules: Awaited<ReturnType<typeof loadModules>>;
let originalGetSettings: unknown;

async function loadModules() {
    const permissions = await import('../src/utils/permissions.js');
    const { guildSettingsManager } = await import('../src/services/GuildSettingsManager.js');
    const queueCommand = await import('../src/commands/queue.js');
    const lyricsCommand = await import('../src/commands/lyrics.js');
    const playCommand = await import('../src/commands/play.js');
    const { queueViewManager } = await import('../src/services/QueueViewManager.js');
    const { youtubeService } = await import('../src/services/YouTubeService.js');
    const { mediaCacheManager } = await import('../src/audio/MediaCacheManager.js');
    const { handleLyricsDelete } = await import('../src/utils/lyrics.js');
    const { config } = await import('../src/config.js');
    return {
        permissions,
        guildSettingsManager,
        queueCommand,
        lyricsCommand,
        playCommand,
        queueViewManager,
        youtubeService,
        mediaCacheManager,
        handleLyricsDelete,
        config,
    };
}

function member(userId: string, roleIds: string[] = []) {
    return {
        user: { id: userId, tag: `user-${userId}` },
        id: userId,
        displayName: `user-${userId}`,
        guild: { id: deniedSettings.guildId },
        permissions: { has: () => false },
        roles: {
            cache: {
                map: (mapper: (role: { id: string }) => string) => roleIds.map((id) => mapper({ id })),
            },
        },
        voice: { channel: null, channelId: null },
    };
}

function commandInteraction(memberValue: ReturnType<typeof member>) {
    const replies: Array<Record<string, unknown>> = [];
    return {
        interaction: {
            inGuild: () => true,
            guildId: deniedSettings.guildId,
            locale: 'fr',
            member: memberValue,
            user: memberValue.user,
            deferred: false,
            replied: false,
            options: { getString: () => null },
            reply: async (payload: Record<string, unknown>) => { replies.push(payload); },
            followUp: async (payload: Record<string, unknown>) => { replies.push(payload); },
            deleteReply: async () => undefined,
        },
        replies,
    };
}

before(async () => {
    await mkdir(testDataDir, { recursive: true });
    modules = await loadModules();
    await (modules.mediaCacheManager as any).ready;
    originalGetSettings = modules.guildSettingsManager.getSettings;
    modules.guildSettingsManager.getSettings = async () => ({ ...deniedSettings });
    modules.config.audio.ephemeralInfoDeleteDelay = 1;
});

after(async () => {
    modules.guildSettingsManager.getSettings = originalGetSettings as typeof modules.guildSettingsManager.getSettings;
    await (modules.mediaCacheManager as any).ready;
    await (modules.mediaCacheManager as any).manifestWrite;
    await rm(testDataDir, { recursive: true, force: true });
});

test('the accepted Discord administrator keeps use and settings access despite guild rules', async () => {
    const acceptedAdministrator = member('189457295279783936');

    assert.equal(await modules.permissions.canUseBot(acceptedAdministrator as never), true);
    assert.equal(await modules.permissions.canManageSettings(acceptedAdministrator as never), true);
});

test('normal members still follow the configured role policy', async () => {
    assert.equal(await modules.permissions.canUseBot(member('200000000000000001') as never), false);
    assert.equal(
        await modules.permissions.canUseBot(member('200000000000000002', ['allowed-role']) as never),
        true
    );
});

test('/queue and /lyrics stop before their privileged behavior for a denied member', async () => {
    const deniedMember = member('200000000000000003');
    const queue = commandInteraction(deniedMember);
    const lyrics = commandInteraction(deniedMember);
    let queueShown = false;
    const originalShow = modules.queueViewManager.show;
    modules.queueViewManager.show = async () => { queueShown = true; };

    try {
        await modules.queueCommand.execute(queue.interaction as never);
        await modules.lyricsCommand.execute(lyrics.interaction as never);
    } finally {
        modules.queueViewManager.show = originalShow;
    }

    assert.equal(queueShown, false);
    assert.equal(queue.replies.length, 1);
    assert.equal(lyrics.replies.length, 1);
    assert.match(String(queue.replies[0]?.content), /permission/i);
    assert.match(String(lyrics.replies[0]?.content), /permission/i);
});

test('/play autocomplete returns no catalogue data to a denied member', async () => {
    let searchCalls = 0;
    const responses: Array<Array<{ name: string; value: string }>> = [];
    const originalSearch = modules.youtubeService.search;
    modules.youtubeService.search = async () => {
        searchCalls += 1;
        return [];
    };

    try {
        await modules.playCommand.autocomplete({
            inCachedGuild: () => true,
            member: member('200000000000000004'),
            guildId: deniedSettings.guildId,
            channelId: 'channel',
            user: { id: '200000000000000004' },
            locale: 'fr',
            options: { getFocused: () => 'private query' },
            respond: async (options: Array<{ name: string; value: string }>) => { responses.push(options); },
        } as never);
    } finally {
        modules.youtubeService.search = originalSearch;
    }

    assert.equal(searchCalls, 0);
    assert.deepEqual(responses, [[]]);
});

test('a delayed playlist choice is rejected when the accepted administrator has left voice', async () => {
    const acceptedAdministrator = member('189457295279783936');
    const voiceChannel = { id: 'voice-playlist', isVoiceBased: () => true };
    const textChannel = { id: 'text-playlist' };
    const channels = new Map<string, unknown>([
        [voiceChannel.id, voiceChannel],
        [textChannel.id, textChannel],
    ]);
    const guild = {
        id: deniedSettings.guildId,
        channels: { cache: channels },
    };
    acceptedAdministrator.guild = guild as never;
    acceptedAdministrator.voice.channel = voiceChannel as never;
    acceptedAdministrator.voice.channelId = voiceChannel.id;

    const commandUpdates: Array<Record<string, unknown>> = [];
    await modules.playCommand.execute({
        inGuild: () => true,
        guildId: deniedSettings.guildId,
        guild,
        locale: 'fr',
        member: acceptedAdministrator,
        user: acceptedAdministrator.user,
        channel: textChannel,
        options: {
            getString: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL-test-playlist',
        },
        deferReply: async () => undefined,
        editReply: async (payload: Record<string, unknown>) => { commandUpdates.push(payload); },
        deleteReply: async () => undefined,
    } as never);

    const choicePayload = commandUpdates.at(-1);
    const rows = choicePayload?.components as Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
    const playlistChoiceId = rows[0]?.toJSON().components[1]?.custom_id;
    assert.ok(playlistChoiceId, 'le bouton de choix playlist doit être créé');

    acceptedAdministrator.voice.channel = null;
    acceptedAdministrator.voice.channelId = null;
    let playlistResolutionCalls = 0;
    const originalGetPlaylistTracks = modules.youtubeService.getPlaylistTracks;
    modules.youtubeService.getPlaylistTracks = async () => {
        playlistResolutionCalls += 1;
        return null;
    };
    const buttonUpdates: Array<Record<string, unknown>> = [];

    try {
        await modules.playCommand.handlePlaylistChoice({
            customId: playlistChoiceId,
            user: acceptedAdministrator.user,
            guildId: deniedSettings.guildId,
            guild,
            locale: 'fr',
            member: acceptedAdministrator,
            inCachedGuild: () => true,
            update: async (payload: Record<string, unknown>) => { buttonUpdates.push(payload); },
            reply: async (payload: Record<string, unknown>) => { buttonUpdates.push(payload); },
        } as never);
    } finally {
        modules.youtubeService.getPlaylistTracks = originalGetPlaylistTracks;
    }

    assert.equal(playlistResolutionCalls, 0, 'aucune résolution média ne doit commencer après le départ vocal');
    assert.equal(buttonUpdates.length, 1);
    assert.match(String(buttonUpdates[0]?.content), /canal vocal/i);
    assert.deepEqual(buttonUpdates[0]?.components, []);
});

test('queue and lyrics components re-check permissions when clicked', async () => {
    const deniedMember = member('200000000000000005');
    const queueReplies: Array<Record<string, unknown>> = [];
    const lyricsReplies: Array<Record<string, unknown>> = [];
    const base = {
        inCachedGuild: () => true,
        member: deniedMember,
        guildId: deniedSettings.guildId,
        locale: 'fr',
        deferred: false,
        replied: false,
        deleteReply: async () => undefined,
    };

    await modules.queueViewManager.handleComponentInteraction({
        ...base,
        message: { id: 'queue-message' },
        customId: 'queue_delete_all',
        reply: async (payload: Record<string, unknown>) => { queueReplies.push(payload); },
        followUp: async (payload: Record<string, unknown>) => { queueReplies.push(payload); },
    } as never);
    await modules.handleLyricsDelete({
        ...base,
        customId: 'lyrics_delete',
        reply: async (payload: Record<string, unknown>) => { lyricsReplies.push(payload); },
        followUp: async (payload: Record<string, unknown>) => { lyricsReplies.push(payload); },
    } as never);

    assert.equal(queueReplies.length, 1);
    assert.equal(lyricsReplies.length, 1);
    assert.match(String(queueReplies[0]?.content), /permission/i);
    assert.match(String(lyricsReplies[0]?.content), /permission/i);
});
