import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    Collection,
    EmbedBuilder,
    ModalBuilder,
    Role,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import type { GuildSettings, RolePermissionMode, VoiceChannelMode } from '../types/index.js';
import { booleanLabel, localeLabel, modeLabel, t } from './i18n.js';

export const SETTINGS_BUTTON_IDS = {
    volume: 'settings_volume',
    locale: 'settings_locale',
    stay: 'settings_stay',
    always: 'settings_always',
    pauseOnEmpty: 'settings_pause_on_empty',
    crossfade: 'settings_crossfade',
    sponsor: 'settings_sponsor',
    preferred: 'settings_preferred',
    voice: 'settings_voice',
    roles: 'settings_roles',
} as const;

export const SETTINGS_SELECT_IDS = {
    localeSelect: 'settings_locale_select',
    preferredSelect: 'settings_preferred_select',
    preferredClear: 'settings_preferred_clear',
    voiceMode: 'settings_voice_mode',
    voiceList: 'settings_voice_list',
    rolesMode: 'settings_roles_mode',
    rolesList: 'settings_roles_list',
    rolesAdd: 'settings_roles_add',
    rolesClear: 'settings_roles_clear',
    rolesPrev: 'settings_roles_prev',
    rolesNext: 'settings_roles_next',
} as const;

export type SettingsModalKind = 'volume';

type SettingsSelectId = (typeof SETTINGS_SELECT_IDS)[keyof typeof SETTINGS_SELECT_IDS];

type SettingsComponents = ActionRowBuilder<
    ButtonBuilder | StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder
>;

const MODAL_PREFIX = 'settings_modal';
const ROLES_ADD_MODAL_PREFIX = 'settings_roles_add_modal';

export function buildSettingsMessage(settings: GuildSettings): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
} {
    const locale = settings.locale;
    const lines = [
        `🔊 ${t(locale, 'settings.volume')}: ${settings.volume}%`,
        `🌐 ${t(locale, 'settings.language')}: ${localeLabel(locale)}`,
        `📌 ${t(locale, 'settings.stayConnected')}: ${booleanLabel(locale, settings.stayConnected)}`,
        `🔗 ${t(locale, 'settings.alwaysConnected')}: ${booleanLabel(locale, settings.stayConnectedAlways)}`,
        `⏸️ ${t(locale, 'settings.pauseOnEmpty')}: ${booleanLabel(locale, settings.pauseOnEmptyChannelWhenAlwaysConnected)}`,
        `🎚️ ${t(locale, 'settings.crossfade')}: ${settings.crossfadeEnabled ? `${t(locale, 'settings.value.enabled')} (3s)` : t(locale, 'settings.value.disabled')}`,
        `🎶 SponsorBlock: ${booleanLabel(locale, settings.sponsorBlockEnabled)}`,
        `🎙️ ${t(locale, 'settings.preferredChannel')}: ${settings.preferredVoiceChannel ? `<#${settings.preferredVoiceChannel}>` : t(locale, 'settings.channel.none')}`,
        `🚪 ${t(locale, 'settings.voiceChannels')}: ${formatModeLabel(locale, settings.voiceChannelMode, settings.allowedVoiceChannels.length, settings.blockedVoiceChannels.length)}`,
        `👥 ${t(locale, 'settings.roles')}: ${formatModeLabel(locale, settings.rolePermissionMode, settings.allowedRoles.length, settings.blockedRoles.length)}`,
    ];

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`⚙️ ${t(locale, 'settings.title')}`)
        .setDescription(lines.join('\n'));

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.volume)
            .setEmoji('🔊')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.locale)
            .setEmoji('🌐')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.stay)
            .setEmoji('📌')
            .setStyle(settings.stayConnected ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.always)
            .setEmoji('🔗')
            .setStyle(settings.stayConnectedAlways ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.preferred)
            .setEmoji('🎙️')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.voice)
            .setEmoji('🚪')
            .setStyle(modeButtonStyle(settings.voiceChannelMode)),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.roles)
            .setEmoji('👥')
            .setStyle(modeButtonStyle(settings.rolePermissionMode))
    );

    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.pauseOnEmpty)
            .setEmoji('⏸️')
            .setStyle(settings.pauseOnEmptyChannelWhenAlwaysConnected ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.crossfade)
            .setEmoji('🎚️')
            .setStyle(settings.crossfadeEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(SETTINGS_BUTTON_IDS.sponsor)
            .setEmoji('🎶')
            .setStyle(settings.sponsorBlockEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

export function buildSettingsModal(
    kind: SettingsModalKind,
    settings: GuildSettings,
    messageId: string
): ModalBuilder {
    const locale = settings.locale;
    const modal = new ModalBuilder().setCustomId(`${MODAL_PREFIX}:${kind}:${messageId}`);

    modal.setTitle(t(locale, 'settings.volumeModalTitle'));
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(t(locale, 'settings.volumeModalLabel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(settings.volume));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return modal;
}

export function buildRolesAddModal(messageId: string, locale: 'en' | 'fr'): ModalBuilder {
    const modal = new ModalBuilder().setCustomId(`${ROLES_ADD_MODAL_PREFIX}:${messageId}`);
    modal.setTitle(t(locale, 'settings.rolesAddTitle'));
    const input = new TextInputBuilder()
        .setCustomId('roles')
        .setLabel(t(locale, 'settings.rolesAddLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return modal;
}

export function parseSettingsModalId(customId: string): { kind: SettingsModalKind; messageId: string } | null {
    if (!customId.startsWith(`${MODAL_PREFIX}:`)) return null;
    const parts = customId.split(':');
    if (parts.length !== 3) return null;
    const kind = parts[1] as SettingsModalKind;
    const messageId = parts[2];
    if (!messageId) return null;
    if (!['volume'].includes(kind)) return null;
    return { kind, messageId };
}

export function parseRolesAddModalId(customId: string): string | null {
    if (!customId.startsWith(`${ROLES_ADD_MODAL_PREFIX}:`)) return null;
    const parts = customId.split(':');
    if (parts.length !== 2) return null;
    return parts[1] || null;
}

export function buildLocalePrompt(settings: GuildSettings, messageId: string): {
    content: string;
    components: SettingsComponents[];
} {
    const locale = settings.locale;
    const select = new StringSelectMenuBuilder()
        .setCustomId(`${SETTINGS_SELECT_IDS.localeSelect}:${messageId}`)
        .setPlaceholder(t(locale, 'settings.selectLanguagePlaceholder'))
        .addOptions(
            { label: localeLabel('fr'), value: 'fr', default: settings.locale === 'fr' },
            { label: localeLabel('en'), value: 'en', default: settings.locale === 'en' }
        );

    return {
        content: t(locale, 'settings.choiceLanguage'),
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    };
}

export function buildPreferredChannelPrompt(settings: GuildSettings, messageId: string): {
    content: string;
    components: SettingsComponents[];
} {
    const locale = settings.locale;
    const select = new ChannelSelectMenuBuilder()
        .setCustomId(`${SETTINGS_SELECT_IDS.preferredSelect}:${messageId}`)
        .setPlaceholder(t(locale, 'settings.preferredPlaceholder'))
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setMinValues(1)
        .setMaxValues(1);

    const clearButton = new ButtonBuilder()
        .setCustomId(`${SETTINGS_SELECT_IDS.preferredClear}:${messageId}`)
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Secondary);

    const info = t(locale, 'settings.promptCurrentChannel', {
        channel: settings.preferredVoiceChannel ? `<#${settings.preferredVoiceChannel}>` : t(locale, 'settings.channel.none'),
    });

    return {
        content: `${t(locale, 'settings.promptPreferred')}\n${info}`,
        components: [
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(clearButton),
        ],
    };
}

export function buildVoiceChannelsPrompt(settings: GuildSettings, messageId: string): {
    content: string;
    components: SettingsComponents[];
} {
    const locale = settings.locale;
    const modeSelect = new StringSelectMenuBuilder()
        .setCustomId(`${SETTINGS_SELECT_IDS.voiceMode}:${messageId}`)
        .setPlaceholder(t(locale, 'settings.voiceModePlaceholder'))
        .addOptions(
            {
                label: t(locale, 'settings.mode.allow_all'),
                value: 'allow_all',
                default: settings.voiceChannelMode === 'allow_all',
            },
            {
                label: 'Whitelist',
                value: 'whitelist',
                default: settings.voiceChannelMode === 'whitelist',
            },
            {
                label: 'Blacklist',
                value: 'blacklist',
                default: settings.voiceChannelMode === 'blacklist',
            }
        );

    const components: SettingsComponents[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modeSelect),
    ];

    if (settings.voiceChannelMode !== 'allow_all') {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`${SETTINGS_SELECT_IDS.voiceList}:${messageId}`)
            .setPlaceholder(t(locale, 'settings.voiceListPlaceholder'))
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setMinValues(0)
            .setMaxValues(25);
        components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect));
    }

    const count = settings.voiceChannelMode === 'whitelist'
        ? settings.allowedVoiceChannels.length
        : settings.voiceChannelMode === 'blacklist'
            ? settings.blockedVoiceChannels.length
            : 0;

    return {
        content: t(locale, 'settings.promptVoiceMode', {
            mode: formatModeLabel(locale, settings.voiceChannelMode, count, count),
        }) + (settings.voiceChannelMode === 'allow_all' ? ` ${t(locale, 'settings.promptVoiceNone')}` : ''),
        components,
    };
}

export function buildRolesPrompt(
    settings: GuildSettings,
    messageId: string,
    roles?: Collection<string, Role>,
    page = 0
): {
    content: string;
    components: SettingsComponents[];
} {
    const locale = settings.locale;
    const modeSelect = new StringSelectMenuBuilder()
        .setCustomId(`${SETTINGS_SELECT_IDS.rolesMode}:${messageId}`)
        .setPlaceholder(t(locale, 'settings.rolesModePlaceholder'))
        .addOptions(
            {
                label: t(locale, 'settings.mode.allow_all'),
                value: 'allow_all',
                default: settings.rolePermissionMode === 'allow_all',
            },
            {
                label: 'Whitelist',
                value: 'whitelist',
                default: settings.rolePermissionMode === 'whitelist',
            },
            {
                label: 'Blacklist',
                value: 'blacklist',
                default: settings.rolePermissionMode === 'blacklist',
            }
        );

    const components: SettingsComponents[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modeSelect),
    ];

    let pageInfo = '';

    if (settings.rolePermissionMode !== 'allow_all') {
        const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${SETTINGS_SELECT_IDS.rolesAdd}:${messageId}`)
                .setEmoji('➕')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${SETTINGS_SELECT_IDS.rolesClear}:${messageId}`)
                .setEmoji('🧹')
                .setStyle(ButtonStyle.Secondary)
        );

        if (roles && roles.size > 0) {
            const { pageRoles, pageCount, total, page: safePage } = getPagedRoles(roles, page);
            if (pageRoles.length > 0) {
                const roleSelect = new StringSelectMenuBuilder()
                    .setCustomId(`${SETTINGS_SELECT_IDS.rolesList}:${messageId}:${safePage}`)
                    .setPlaceholder(t(locale, 'settings.rolesListPlaceholder'))
                    .setMinValues(0)
                    .setMaxValues(Math.min(25, pageRoles.length))
                    .addOptions(
                        pageRoles.map((role) => ({
                            label: trimLabel(role.name),
                            value: role.id,
                            default:
                                settings.rolePermissionMode === 'whitelist'
                                    ? settings.allowedRoles.includes(role.id)
                                    : settings.rolePermissionMode === 'blacklist'
                                        ? settings.blockedRoles.includes(role.id)
                                        : false,
                        }))
                    );
                components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(roleSelect));
            }

            if (pageCount > 1) {
                actions.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`${SETTINGS_SELECT_IDS.rolesPrev}:${messageId}:${safePage}`)
                        .setEmoji('⬅️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(safePage <= 0),
                    new ButtonBuilder()
                        .setCustomId(`${SETTINGS_SELECT_IDS.rolesNext}:${messageId}:${safePage}`)
                        .setEmoji('➡️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(safePage >= pageCount - 1)
                );
                pageInfo = t(locale, 'settings.promptRolesPage', { page: safePage + 1, pages: pageCount, total });
            } else if (total > 0) {
                pageInfo = t(locale, 'settings.promptRolesCount', { count: total });
            }
        } else {
            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId(`${SETTINGS_SELECT_IDS.rolesList}:${messageId}`)
                .setPlaceholder(t(locale, 'settings.rolesListPlaceholder'))
                .setMinValues(0)
                .setMaxValues(25);
            components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect));
        }

        components.push(actions as unknown as SettingsComponents);
    }

    const count = settings.rolePermissionMode === 'whitelist'
        ? settings.allowedRoles.length
        : settings.rolePermissionMode === 'blacklist'
            ? settings.blockedRoles.length
            : 0;

    return {
        content: t(locale, 'settings.promptRolesMode', {
            mode: formatModeLabel(locale, settings.rolePermissionMode, count, count),
        }) + (settings.rolePermissionMode === 'allow_all' ? ` ${t(locale, 'settings.promptRolesNone')}` : pageInfo),
        components,
    };
}

export function parseSettingsSelectId(
    customId: string
): { id: SettingsSelectId; messageId: string; page?: number } | null {
    const parts = customId.split(':');
    if (parts.length < 2) return null;
    const id = parts[0];
    const messageId = parts[1];
    const pageRaw = parts.length > 2 ? parts[2] : undefined;
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : undefined;
    if (!id || !messageId) return null;
    if (pageRaw && Number.isNaN(page)) return null;
    const values = Object.values(SETTINGS_SELECT_IDS) as SettingsSelectId[];
    if (!values.includes(id as SettingsSelectId)) return null;
    return { id: id as SettingsSelectId, messageId, page };
}

function formatModeLabel(
    locale: string,
    mode: VoiceChannelMode | RolePermissionMode,
    allowCount: number,
    blockCount: number
): string {
    if (mode === 'whitelist') {
        return modeLabel(locale, mode, allowCount);
    }
    if (mode === 'blacklist') {
        return modeLabel(locale, mode, blockCount);
    }
    return modeLabel(locale, mode, 0);
}

function modeButtonStyle(mode: VoiceChannelMode | RolePermissionMode): ButtonStyle {
    if (mode === 'whitelist') return ButtonStyle.Success;
    if (mode === 'blacklist') return ButtonStyle.Danger;
    return ButtonStyle.Secondary;
}

function trimLabel(label: string): string {
    if (label.length <= 100) return label;
    return `${label.slice(0, 97)}...`;
}

export function getPagedRoles(
    roles: Collection<string, Role>,
    page: number,
    pageSize = 25
): { pageRoles: Role[]; page: number; pageCount: number; total: number } {
    const allRoles = Array.from(roles.values()).sort((a, b) => b.position - a.position);
    const total = allRoles.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(0, page), pageCount - 1);
    const start = safePage * pageSize;
    const pageRoles = allRoles.slice(start, start + pageSize);
    return { pageRoles, page: safePage, pageCount, total };
}
