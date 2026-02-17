import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';
import { logger } from '../utils/Logger.js';
import type { GuildSettings } from '../types/index.js';

const log = logger.createModuleLogger('GuildSettings');

class GuildSettingsManager {
    private cache: Map<string, GuildSettings> = new Map();
    private saveQueue: Map<string, NodeJS.Timeout> = new Map();

    constructor() {
        this.ensureGuildsDir();
    }

    private ensureGuildsDir(): void {
        if (!existsSync(config.paths.guilds)) {
            mkdirSync(config.paths.guilds, { recursive: true });
            log.debug('Dossier guild créé');
        }
    }

    private ensureGuildDir(guildId: string): void {
        const guildDir = join(config.paths.guilds, guildId);
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
            preferredVoiceChannel: null,
            voiceChannelMode: 'allow_all',
            allowedVoiceChannels: [],
            blockedVoiceChannels: [],
            rolePermissionMode: 'allow_all',
            allowedRoles: [],
            blockedRoles: [],
        };
    }

    async getSettings(guildId: string): Promise<GuildSettings> {
        if (this.cache.has(guildId)) {
            return this.cache.get(guildId)!;
        }

        const settings = await this.loadSettings(guildId);
        this.cache.set(guildId, settings);
        return settings;
    }

    private async loadSettings(guildId: string): Promise<GuildSettings> {
        const filePath = this.getFilePath(guildId);
        const legacyPath = join(config.paths.data, 'guilds', `${guildId}.json`);

        if (!existsSync(filePath)) {
            if (existsSync(legacyPath)) {
                try {
                    const legacyData = await readFile(legacyPath, 'utf-8');
                    const parsed = JSON.parse(legacyData) as Partial<GuildSettings>;
                    const defaults = this.getDefaults(guildId);
                    const migrated = { ...defaults, ...parsed, guildId };
                    await this.ensureSettingsFile(guildId, migrated);
                    log.debug(`Settings migrés depuis l'ancien format pour guild ${guildId}`);
                    return migrated;
                } catch (error) {
                    log.error(`Erreur migration settings pour guild ${guildId}:`, error);
                }
            }

            log.debug(`Pas de settings pour guild ${guildId}, utilisation des défauts`);
            const defaults = this.getDefaults(guildId);
            await this.ensureSettingsFile(guildId, defaults);
            return defaults;
        }

        try {
            const data = await readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data) as Partial<GuildSettings>;
            const defaults = this.getDefaults(guildId);

            return { ...defaults, ...parsed, guildId };
        } catch (error) {
            log.error(`Erreur lecture settings pour guild ${guildId}:`, error);
            return this.getDefaults(guildId);
        }
    }

    async saveSettings(guildId: string, settings: GuildSettings): Promise<void> {
        this.cache.set(guildId, settings);

        if (this.saveQueue.has(guildId)) {
            clearTimeout(this.saveQueue.get(guildId)!);
        }

        const timeout = setTimeout(async () => {
            await this.flushSettings(guildId);
            this.saveQueue.delete(guildId);
        }, 500);

        this.saveQueue.set(guildId, timeout);
    }

    private async flushSettings(guildId: string): Promise<void> {
        const settings = this.cache.get(guildId);
        if (!settings) return;

        const filePath = this.getFilePath(guildId);

        try {
            this.ensureGuildDir(guildId);
            const data = JSON.stringify(settings, null, 2);
            await writeFile(filePath, data, 'utf-8');
            log.debug(`Settings sauvegardés pour guild ${guildId}`);
        } catch (error) {
            log.error(`Erreur sauvegarde settings pour guild ${guildId}:`, error);
        }
    }

    async updateSettings(guildId: string, updates: Partial<GuildSettings>): Promise<GuildSettings> {
        const current = await this.getSettings(guildId);
        const updated = { ...current, ...updates, guildId };
        await this.saveSettings(guildId, updated);
        return updated;
    }

    private getFilePath(guildId: string): string {
        return join(config.paths.guilds, guildId, 'settings.json');
    }

    private async ensureSettingsFile(guildId: string, settings: GuildSettings): Promise<void> {
        const filePath = this.getFilePath(guildId);
        if (existsSync(filePath)) return;
        try {
            this.ensureGuildDir(guildId);
            const data = JSON.stringify(settings, null, 2);
            await writeFile(filePath, data, 'utf-8');
            log.debug(`Settings par défaut créés pour guild ${guildId}`);
        } catch (error) {
            log.error(`Erreur création settings pour guild ${guildId}:`, error);
        }
    }

    clearCache(guildId?: string): void {
        if (guildId) {
            this.cache.delete(guildId);
        } else {
            this.cache.clear();
        }
    }
}

export const guildSettingsManager = new GuildSettingsManager();
