import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function registerCommands() {
    try {
        console.log('🔄 Début de l\'enregistrement des commandes slash...');

        const commandsData = commands.map(cmd => cmd.data.toJSON());

        // Enregistrer globalement
        console.log('📡 Enregistrement global des commandes...');
        await rest.put(
            Routes.applicationCommands(config.discord.clientId),
            { body: commandsData }
        );
        console.log('✅ Commandes globales enregistrées.');

        // Enregistrer dans le serveur de test (mise à jour instantanée)
        console.log(`📡 Enregistrement dans le serveur de test (${config.discord.guildId})...`);
        await rest.put(
            Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
            { body: commandsData }
        );
        console.log('✅ Commandes du serveur de test enregistrées.');

        console.log(`✅ ${commandsData.length} commande(s) enregistrée(s) avec succès!`);
        console.log('📋 Commandes disponibles:');
        commandsData.forEach(cmd => {
            console.log(`   /${cmd.name} - ${cmd.description}`);
        });

    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
        process.exit(1);
    }
}

registerCommands();
