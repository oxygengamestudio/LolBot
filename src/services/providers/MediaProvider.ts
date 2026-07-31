import type { PlaylistInfo, SearchResult, Track } from '../../types/index.js';

export interface MediaSearchContext {
    /** Stable tenant key used to enforce per-guild concurrency. */
    scopeKey?: string;
    /** Cancels queued work and any child process started for this search. */
    signal?: AbortSignal;
}

export interface UrlMediaProvider {
    readonly provider: string;

    matchesUrl(url: string): boolean;
    createTrackFromUrl(
        url: string,
        requestedBy: string,
        requestedById: string,
        context?: MediaSearchContext
    ): Promise<Track | null>;
}

export interface MediaProvider extends UrlMediaProvider {
    search(query: string, maxResults?: number, context?: MediaSearchContext): Promise<SearchResult[]>;
    createTrackFromSearch(result: SearchResult, requestedBy: string, requestedById: string): Promise<Track>;
    getPlaylistTracks(
        playlistId: string,
        requestedBy: string,
        requestedById: string,
        context?: MediaSearchContext
    ): Promise<PlaylistInfo | null>;
}
