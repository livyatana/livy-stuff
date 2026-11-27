export interface WatchlistRow {
  name: string;
  year: string;
}

export interface MovieRecord {
  id: number;
  title: string;
  year: string;
  poster_path: string;
  overview: string;
  vote_average: number;
  media_type?: 'movie' | 'tv';
  genre?: string | null;
  runtime?: number | null;
  isPreviewFallback?: boolean;
}

export interface MovieDetails {
  genre: string | null;
  runtime: number | null;
  mediaType: 'movie' | 'tv';
}

export interface UnmatchedEntry {
  name: string;
  year: string;
  reason: 'Not found' | 'No poster' | 'Request error';
}

export interface MovieCachePayload {
  movies: MovieRecord[];
  unmatched: UnmatchedEntry[];
  syncedAt: string;
}

export interface SyncProgress {
  completed: number;
  total: number;
  matched: number;
  currentTitle: string;
}

export interface RollHistoryState {
  recentIds: number[];
  totalRolledCount: number;
  uniqueRolledIds: number[];
}
