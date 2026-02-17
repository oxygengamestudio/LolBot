import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function registerCommands(): Promise<void> {
    try {
        console.log('[INFO] Starting slash command registration...');

        const commandsData = commands.map((cmd) => cmd.data.toJSON());

        console.log('[INFO] Registering global commands...');
        await rest.put(Routes.applicationCommands(config.discord.clientId), {
            body: commandsData,
        });
        console.log('[OK] Global commands registered.');

        if (config.discord.guildId) {
            console.log(`[INFO] Registering guild commands (${config.discord.guildId})...`);
            await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
                body: commandsData,
            });
            console.log('[OK] Guild commands registered.');
        } else {
            console.log('[INFO] DISCORD_GUILD_ID is not set. Skipping guild command registration.');
        }

        console.log(`[OK] ${commandsData.length} command(s) registered.`);
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
