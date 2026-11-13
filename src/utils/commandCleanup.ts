/** Sous-ensemble du client REST de discord.js utilisé ici, pour rester testable hors ligne. */
export interface CommandRest {
    get(route: `/${string}`): Promise<unknown>;
    put(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

export interface GuildCommandCleanupResult {
    /** Serveurs où d'anciennes commandes ont été supprimées. */
    cleaned: string[];
    /** Serveurs qui n'ont pas pu être vérifiés (accès refusé, erreur réseau). */
    failed: string[];
}

/**
 * Quand les commandes sont enregistrées globalement, toute commande encore
 * enregistrée au niveau d'un serveur apparaît en double dans Discord, souvent
 * dans une version périmée. Cette passe les supprime serveur par serveur.
 */
export async function clearStaleGuildCommands(
    rest: CommandRest,
    guildCommandsRoute: (guildId: string) => `/${string}`,
    guildIds: Iterable<string>
): Promise<GuildCommandCleanupResult> {
    const result: GuildCommandCleanupResult = { cleaned: [], failed: [] };

    for (const guildId of guildIds) {
        try {
            const existing = await rest.get(guildCommandsRoute(guildId));
            if (!Array.isArray(existing) || existing.length === 0) {
                continue;
            }
            await rest.put(guildCommandsRoute(guildId), { body: [] });
            result.cleaned.push(guildId);
        } catch {
            // Un serveur inaccessible ne doit pas empêcher le nettoyage des autres.
            result.failed.push(guildId);
        }
    }

    return result;
}
