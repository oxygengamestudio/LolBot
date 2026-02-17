export type LocaleKey = 'en' | 'fr';

type TranslationMap = Record<string, string>;

const translations: Record<LocaleKey, TranslationMap> = {
    en: {
        'queue.title': 'Queue {page}/{pages}',
        'queue.footer': 'Queue {count}',
        'queue.listTitle': 'List',
        'queue.empty': 'Queue empty.',
        'queue.selectPlaceholder': 'Select a track',
        'queue.controlsTitle': 'Controls',
        'queue.controlsText': '🗑️ Delete track | 📄 Delete page | 🧹 Clear queue | ↕️ Move track',
        'queue.btnDeleteSelected': 'Track',
        'queue.btnDeletePage': 'Page',
        'queue.btnDeleteAll': 'All',
        'queue.btnMove': 'Move',
        'queue.noSelection': 'Select a track first.',
        'queue.noQueue': 'Queue empty.',
        'queue.moveTitle': 'Move track',
        'queue.moveLabel': 'Position',
        'queue.movePlaceholder': '1-100 / start / end',
        'queue.invalidMove': 'Invalid position.',
        'queue.invalidAction': 'Action unavailable.',
        'lyrics.loading': 'Fetching lyrics...',
        'lyrics.notFound': 'Lyrics not found.',
        'lyrics.noTrack': 'No track playing.',
        'lyrics.title': 'Lyrics',
        'lyrics.open': 'Open on Genius',
        'lyrics.truncated': 'Lyrics truncated.',
        'lyrics.sent': 'Lyrics posted.',
        'error.generic': 'Something went wrong.',
    },
    fr: {
        'queue.title': 'File {page}/{pages}',
        'queue.footer': 'File {count}',
        'queue.listTitle': 'Liste',
        'queue.empty': 'File vide.',
        'queue.selectPlaceholder': 'Choisir une piste',
        'queue.controlsTitle': 'Controles',
        'queue.controlsText': '🗑️ Supprimer piste | 📄 Supprimer page | 🧹 Vider file | ↕️ Deplacer',
        'queue.btnDeleteSelected': 'Piste',
        'queue.btnDeletePage': 'Page',
        'queue.btnDeleteAll': 'Tout',
        'queue.btnMove': 'Deplacer',
        'queue.noSelection': 'Selectionne une piste.',
        'queue.noQueue': 'File vide.',
        'queue.moveTitle': 'Deplacer piste',
        'queue.moveLabel': 'Position',
        'queue.movePlaceholder': '1-100 / debut / fin',
        'queue.invalidMove': 'Position invalide.',
        'queue.invalidAction': 'Action indisponible.',
        'lyrics.loading': 'Recherche des paroles...',
        'lyrics.notFound': 'Paroles introuvables.',
        'lyrics.noTrack': 'Aucune musique en cours.',
        'lyrics.title': 'Paroles',
        'lyrics.open': 'Ouvrir sur Genius',
        'lyrics.truncated': 'Paroles tronquees.',
        'lyrics.sent': 'Paroles envoyees.',
        'error.generic': 'Une erreur est survenue.',
    },
};

export function getLocale(locale: string | null | undefined): LocaleKey {
    if (locale && locale.toLowerCase().startsWith('fr')) {
        return 'fr';
    }
    return 'en';
}

export function t(locale: string | null | undefined, key: string, vars?: Record<string, string | number>): string {
    const resolvedLocale = getLocale(locale);
    const template = translations[resolvedLocale][key] ?? translations.en[key] ?? key;

    if (!vars) {
        return template;
    }

    return template.replace(/\{(\w+)\}/g, (match, name) => {
        const value = vars[name];
        return value === undefined ? match : String(value);
    });
}
