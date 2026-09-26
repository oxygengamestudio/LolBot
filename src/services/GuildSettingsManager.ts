import { existsSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { writeJsonAtomic } from '../utils/atomicJson.js';
import { join } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import type { GuildSettings, RolePermissionMode, VoiceChannelMode } from '../types/index.js';

const log = logger.createModuleLogger('GuildSettings');

type StoredGuildSettings = Partial<GuildSettings> & {
    _meta?: {
        localeConfigured?: boolean;
    };
};

export class GuildSettingsManager {
    private cache: Map<string, GuildSettings> = new Map();
    private saveQueue: Map<string, NodeJS.Timeout> = new Map();
    private localeConfigured: Map<string, boolean> = new Map();
    private loads = new Map<string, Promise<GuildSettings>>();
    private mutations = new Map<string, Promise<unknown>>();
    private writes = new Map<string, Promise<void>>();
    private dirty = new Set<string>();

    constructor(private readonly guildsDir = config.paths.guilds, private readonly dataDir = config.paths.data) {
        this.ensureGuildsDir();
    }

    private ensureGuildsDir(): void {
        if (!existsSync(this.guildsDir)) {
            mkdirSync(this.guildsDir, { recursive: true });
            log.debug('Dossier guild créé');
        }
    }

    private ensureGuildDir(guildId: string): void {
        const guildDir = join(this.guildsDir, guildId);
        if (!existsSync(guildDir)) {
            mkdirSync(guildDir, { recursive: true });
            log.debug(`Dossier guild créé pour ${guildId}`);
        }
    }

    getDefaults(guildId: string): GuildSettings {
        return {
            guildId,
            locale: 'fr',
            volume: 100,
            stayConnected: false,
            stayConnectedAlways: false,
            pauseOnEmptyChannelWhenAlwaysConnected: false,
            crossfadeEnabled: false,
            preferredVoiceChannel: null,
            voiceChannelMode: 'allow_all',
            allowedVoiceChannels: [],
            blockedVoiceChannels: [],
            rolePermissionMode: 'allow_all',
            allowedRoles: [],
            blockedRoles: [],
            sponsorBlockEnabled: false,
            queueRecoveryEnabled: false,
        };
    }

    private normalizeMode<TMode extends VoiceChannelMode | RolePermissionMode>(
        value: unknown,
        fallback: TMode
    ): TMode {
        if (value === 'allow_all' || value === 'whitelist' || value === 'blacklist') {
            return value as TMode;
        }
        return fallback;
    }

    private normalizeIdList(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        const ids = value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => /^\d{17,20}$/.test(entry));

        return Array.from(new Set(ids)).slice(0, 100);
    }

    private normalizeSettings(guildId: string, input: Partial<GuildSettings> | null | undefined): GuildSettings {
        const defaults = this.getDefaults(guildId);
        const settings = input ?? {};
        const locale = settings.locale === 'fr' || settings.locale === 'en' ? settings.locale : defaults.locale;
        const volume = Number.isFinite(settings.volume)
            ? Math.max(0, Math.min(200, Math.floor(settings.volume as number)))
            : defaults.volume;

        return {
            guildId,
            locale,
            volume,
            queueRecoveryEnabled: settings.queueRecoveryEnabled === true,
            stayConnected: typeof settings.stayConnected === 'boolean' ? settings.stayConnected : defaults.stayConnected,
            stayConnectedAlways:
                typeof settings.stayConnectedAlways === 'boolean'
                    ? settings.stayConnectedAlways
                    : defaults.stayConnectedAlways,
            pauseOnEmptyChannelWhenAlwaysConnected:
                typeof settings.pauseOnEmptyChannelWhenAlwaysConnected === 'boolean'
                    ? settings.pauseOnEmptyChannelWhenAlwaysConnected
                    : defaults.pauseOnEmptyChannelWhenAlwaysConnected,
            // Keep the upstream migration away from the legacy crossfade pipeline.
            crossfadeEnabled: false,
            sponsorBlockEnabled:
                typeof settings.sponsorBlockEnabled === 'boolean'
                    ? settings.sponsorBlockEnabled
                    : defaults.sponsorBlockEnabled,
            preferredVoiceChannel:
                typeof settings.preferredVoiceChannel === 'string' && /^\d{17,20}$/.test(settings.preferredVoiceChannel)
                    ? settings.preferredVoiceChannel
                    : null,
            voiceChannelMode: this.normalizeMode(settings.voiceChannelMode, defaults.voiceChannelMode),
            allowedVoiceChannels: this.normalizeIdList(settings.allowedVoiceChannels),
            blockedVoiceChannels: this.normalizeIdList(settings.blockedVoiceChannels),
            rolePermissionMode: this.normalizeMode(settings.rolePermissionMode, defaults.rolePermissionMode),
            allowedRoles: this.normalizeIdList(settings.allowedRoles),
            blockedRoles: this.normalizeIdList(settings.blockedRoles),
        };
    }

    async getSettings(guildId: string): Promise<GuildSettings> {
        if (!/^\d{17,20}$/.test(guildId)) throw new Error('Invalid guild ID');
        if (this.cache.has(guildId)) {
            return this.cache.get(guildId)!;
        }

        let pending = this.loads.get(guildId);
        if (!pending) {
            pending = this.loadSettings(guildId).then(settings => {
                this.cache.set(guildId, settings);
                return settings;
            }).finally(() => this.loads.delete(guildId));
            this.loads.set(guildId, pending);
        }
        return pending;
    }

    async isLocaleConfigured(guildId: string): Promise<boolean> {
        if (this.localeConfigured.has(guildId)) {
            return this.localeConfigured.get(guildId)!;
        }

        await this.getSettings(guildId);
        return this.localeConfigured.get(guildId) ?? false;
    }

    private async loadSettings(guildId: string): Promise<GuildSettings> {
        const filePath = this.getFilePath(guildId);
        const legacyPath = join(this.dataDir, 'guilds', `${guildId}.json`);

        if (!existsSync(filePath)) {
            if (existsSync(legacyPath)) {
                try {
                    const legacyData = await readFile(legacyPath, 'utf-8');
                    const parsed = JSON.parse(legacyData) as StoredGuildSettings;
                    const migrated = this.normalizeSettings(guildId, parsed);
                    this.localeConfigured.set(guildId, parsed.locale === 'fr' || parsed.locale === 'en');
                    await this.ensureSettingsFile(guildId, migrated, this.localeConfigured.get(guildId) ?? false);
                    log.debug(`Settings migrés depuis l'ancien format pour guild ${guildId}`);
                    return migrated;
                } catch (error) {
                    log.error(`Erreur migration settings pour guild ${guildId}:`, error);
                    throw error;
                }
            }

            log.debug(`Pas de settings pour guild ${guildId}, utilisation des défauts`);
            const defaults = this.getDefaults(guildId);
            this.localeConfigured.set(guildId, false);
            await this.ensureSettingsFile(guildId, defaults, false);
            return defaults;
        }

        try {
            const data = await readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data) as StoredGuildSettings;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings file');
            this.localeConfigured.set(guildId, parsed._meta?.localeConfigured === true);
            return this.normalizeSettings(guildId, parsed);
        } catch (error) {
            log.error(`Erreur lecture settings pour guild ${guildId}:`, error);
            this.localeConfigured.set(guildId, false);
            throw error;
        }
    }

    async saveSettings(guildId: string, settings: GuildSettings): Promise<void> {
        if (!/^\d{17,20}$/.test(guildId)) throw new Error('Invalid guild ID');
        this.cache.set(guildId, this.normalizeSettings(guildId, settings));
        this.dirty.add(guildId);

        if (this.saveQueue.has(guildId)) {
            clearTimeout(this.saveQueue.get(guildId)!);
        }

        const timeout = setTimeout(() => {
            this.saveQueue.delete(guildId);
            void this.flushSettings(guildId).catch(error => log.error('Settings write failed:', error));
        }, 500);

        this.saveQueue.set(guildId, timeout);
    }

    private async flushSettings(guildId: string): Promise<void> {
        const existing = this.writes.get(guildId);
        if (existing) return existing;
        const pending = (async () => {
            while (this.dirty.delete(guildId)) {
                try {
                    await writeJsonAtomic(this.getFilePath(guildId), this.serializeSettings(guildId, this.cache.get(guildId)!));
                } catch (error) {
                    this.dirty.add(guildId);
                    throw error;
                }
            }
        })().finally(() => this.writes.delete(guildId));
        this.writes.set(guildId, pending);
        return pending;
    }

    async updateSettings(guildId: string, updates: Partial<GuildSettings>): Promise<GuildSettings> {
        const previous = this.mutations.get(guildId) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(() => this.applyUpdate(guildId, updates));
        this.mutations.set(guildId, pending);
        try { return await pending; }
        finally { if (this.mutations.get(guildId) === pending) this.mutations.delete(guildId); }
    }

    private async applyUpdate(guildId: string, updates: Partial<GuildSettings>): Promise<GuildSettings> {
        const current = await this.getSettings(guildId);
        const updated = this.normalizeSettings(guildId, { ...current, ...updates, guildId });
        if (updates.locale === 'fr' || updates.locale === 'en') {
            this.localeConfigured.set(guildId, true);
        }
        await this.saveSettings(guildId, updated);
        return updated;
    }

    private getFilePath(guildId: string): string {
        return join(this.guildsDir, guildId, 'settings.json');
    }

    private serializeSettings(guildId: string, settings: GuildSettings): StoredGuildSettings {
        return {
            ...settings,
            _meta: {
                localeConfigured: this.localeConfigured.get(guildId) ?? false,
            },
        };
    }

    private async ensureSettingsFile(guildId: string, settings: GuildSettings, localeConfigured = false): Promise<void> {
        const filePath = this.getFilePath(guildId);
        if (existsSync(filePath)) return;
        try {
            this.ensureGuildDir(guildId);
            this.localeConfigured.set(guildId, localeConfigured);
            await writeJsonAtomic(filePath, this.serializeSettings(guildId, settings));
            log.debug(`Settings par défaut créés pour guild ${guildId}`);
        } catch (error) {
            log.error(`Erreur création settings pour guild ${guildId}:`, error);
            throw error;
        }
    }

    async flushAll(): Promise<void> {
        await Promise.all([...this.mutations.values(), ...this.loads.values()]);
        for (const timer of this.saveQueue.values()) clearTimeout(timer);
        this.saveQueue.clear();
        await Promise.all([...new Set([...this.dirty, ...this.writes.keys()])].map(id => this.flushSettings(id)));
    }

    get pendingWrites(): number { return this.dirty.size; }

    clearCache(guildId?: string): void {
        if (this.dirty.size || this.writes.size || this.loads.size || this.mutations.size) {
            throw new Error('Flush pending settings before clearing cache');
        }
        if (guildId) {
            this.cache.delete(guildId);
            this.localeConfigured.delete(guildId);
        } else {
            this.cache.clear();
            this.localeConfigured.clear();
        }
    }
}

export const guildSettingsManager = new GuildSettingsManager();
