import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';
import { logger } from './utils/Logger.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const log = logger.createModuleLogger('RegisterCmds');

async function registerCommands(): Promise<void> {
    try {
        log.info('Starting slash command registration');

        const commandsData = commands.map((cmd) => cmd.data.toJSON());

        const configuredScope = config.discord.commandScope;
        const effectiveScope = configuredScope === 'auto'
            ? (config.discord.guildId ? 'guild' : 'global')
            : configuredScope;

        if (effectiveScope === 'guild') {
            if (!config.discord.guildId) {
                throw new Error('DISCORD_COMMAND_SCOPE=guild requires DISCORD_GUILD_ID.');
            }

            log.info(`Registering guild commands (${config.discord.guildId})`);
            await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
                body: commandsData,
            });
            log.info('Guild commands registered');

            log.info('Clearing global commands to avoid duplicates');
            await rest.put(Routes.applicationCommands(config.discord.clientId), {
                body: [],
            });
            log.info('Global commands cleared');
        } else {
            log.info('Registering global commands');
            await rest.put(Routes.applicationCommands(config.discord.clientId), {
                body: commandsData,
            });
            log.info('Global commands registered');

            if (config.discord.guildId) {
                log.info(`Clearing guild commands on ${config.discord.guildId} to avoid duplicates`);
                await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
                    body: [],
                });
                log.info('Guild commands cleared');
            }
        }

        log.info(
            `${commandsData.length} command(s) registered (configured: ${configuredScope}, effective: ${effectiveScope})`
        );
        commandsData.forEach((cmd) => {
            log.debug(`/${cmd.name} - ${cmd.description}`);
        });
    } catch (error) {
        log.error('Failed to register commands', error);
        process.exit(1);
    }
}

void registerCommands();
