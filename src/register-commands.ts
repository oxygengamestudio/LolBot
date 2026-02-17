import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function registerCommands(): Promise<void> {
    try {
        console.log('[INFO] Starting slash command registration...');

        const commandsData = commands.map((cmd) => cmd.data.toJSON());

        const configuredScope = config.discord.commandScope;
        const effectiveScope = configuredScope === 'auto'
            ? (config.discord.guildId ? 'guild' : 'global')
            : configuredScope;

        if (effectiveScope === 'guild') {
            if (!config.discord.guildId) {
                throw new Error('DISCORD_COMMAND_SCOPE=guild requires DISCORD_GUILD_ID.');
            }

            console.log(`[INFO] Registering guild commands (${config.discord.guildId})...`);
            await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
                body: commandsData,
            });
            console.log('[OK] Guild commands registered.');

            console.log('[INFO] Clearing global commands to avoid duplicates...');
            await rest.put(Routes.applicationCommands(config.discord.clientId), {
                body: [],
            });
            console.log('[OK] Global commands cleared.');
        } else {
            console.log('[INFO] Registering global commands...');
            await rest.put(Routes.applicationCommands(config.discord.clientId), {
                body: commandsData,
            });
            console.log('[OK] Global commands registered.');

            if (config.discord.guildId) {
                console.log(`[INFO] Clearing guild commands on ${config.discord.guildId} to avoid duplicates...`);
                await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
                    body: [],
                });
                console.log('[OK] Guild commands cleared.');
            }
        }

        console.log(
            `[OK] ${commandsData.length} command(s) registered (configured: ${configuredScope}, effective: ${effectiveScope}).`
        );
        console.log('[INFO] Available commands:');
        commandsData.forEach((cmd) => {
            console.log(`   /${cmd.name} - ${cmd.description}`);
        });
    } catch (error) {
        console.error('[ERROR] Failed to register commands:', error);
        process.exit(1);
    }
}

registerCommands();
