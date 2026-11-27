import type {
  MovieCachePayload,
  MovieDetails,
  MovieRecord,
  RollHistoryState,
  WatchlistRow,
} from '../types/movie';

export const CACHE_STORAGE_KEY = 'movieDieCache_v2';
const LEGACY_CACHE_STORAGE_KEY = 'movieDieCache_v1';
export const HISTORY_STORAGE_KEY = 'movieDieHistory_v1';
export const WATCHLIST_VERSION_STORAGE_KEY = 'movieDieWatchlistVersion_v1';
export const RECENT_HISTORY_LIMIT = 50;

export interface WatchlistVersionPayload {
  updated: string;
  count?: number;
}

export function parseWatchlistCsv(csvText: string): WatchlistRow[] {
  const rows: WatchlistRow[] = [];
  const lines = csvText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && /^name\s*,\s*year$/i.test(line)) continue;

    // Parse CSV row with support for quoted titles containing commas
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        if (inQuotes && line[c + 1] === '"') {
          current += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());

    if (fields.length >= 2) {
      const name = fields[0];
      const year = fields[1];
      if (name) {
        rows.push({ name, year });
      }
    }
  }

  return rows;
}

export async function fetchWatchlistCsv(): Promise<WatchlistRow[]> {
  const res = await fetch('./data/watchlist.csv', { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Failed to load ./data/watchlist.csv (${res.status})`);
  }
  const text = await res.text();
  return parseWatchlistCsv(text);
}

export function readCachedMovies(): MovieCachePayload | null {
  try {
    localStorage.removeItem(LEGACY_CACHE_STORAGE_KEY);
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MovieCachePayload;
    if (!parsed || !Array.isArray(parsed.movies) || parsed.movies.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearCachedMovies(): void {
  try {
    localStorage.removeItem(LEGACY_CACHE_STORAGE_KEY);
    localStorage.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export async function fetchWatchlistVersion(
  signal?: AbortSignal,
): Promise<WatchlistVersionPayload | null> {
  try {
    const res = await fetch('./data/version.json', { cache: 'no-cache', signal });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (
      data &&
      typeof data === 'object' &&
      'updated' in data &&
      typeof (data as { updated: unknown }).updated === 'string' &&
      (data as { updated: string }).updated.trim().length > 0
    ) {
      const payload = data as { updated: string; count?: unknown };
      return {
        updated: payload.updated.trim(),
        count: typeof payload.count === 'number' ? payload.count : undefined,
      };
    }
    return null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

export function readStoredWatchlistVersion(): string | null {
  try {
    return localStorage.getItem(WATCHLIST_VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredWatchlistVersion(updated: string): void {
  try {
    localStorage.setItem(WATCHLIST_VERSION_STORAGE_KEY, updated);
  } catch {
    // Ignore storage errors
  }
}

export async function tryLoadStaticMoviesJson(
  signal?: AbortSignal,
): Promise<MovieRecord[] | null> {
  try {
    const res = await fetch('./data/movies.json', { cache: 'no-cache', signal });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (Array.isArray(data) && data.length > 0 && 'poster_path' in data[0]) {
      return data as MovieRecord[];
    }
    if (
      data &&
      typeof data === 'object' &&
      'movies' in data &&
      Array.isArray((data as { movies: unknown[] }).movies)
    ) {
      const movies = (data as { movies: MovieRecord[] }).movies;
      return movies.length > 0 ? movies : null;
    }
    return null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

export function buildWatchlistPreviewMovies(rows: WatchlistRow[]): MovieRecord[] {
  return rows.map((row, idx) => ({
    id: -(idx + 1),
    title: row.name,
    year: row.year,
    poster_path: '',
    overview: 'Add ./data/movies.json to load official TMDB posters and metadata.',
    vote_average: 0,
    isPreviewFallback: true,
  }));
}

// --- Roll History ---

export function getRollHistory(): RollHistoryState {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RollHistoryState>;
      return {
        recentIds: Array.isArray(parsed.recentIds) ? parsed.recentIds : [],
        totalRolledCount: typeof parsed.totalRolledCount === 'number' ? parsed.totalRolledCount : 0,
        uniqueRolledIds: Array.isArray(parsed.uniqueRolledIds) ? parsed.uniqueRolledIds : [],
      };
    }
  } catch {
    // Ignore parse error
  }
  return { recentIds: [], totalRolledCount: 0, uniqueRolledIds: [] };
}

export function saveRollHistory(state: RollHistoryState): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore
  }
}

export function resetRollHistory(): RollHistoryState {
  const empty: RollHistoryState = {
    recentIds: [],
    totalRolledCount: 0,
    uniqueRolledIds: [],
  };
  saveRollHistory(empty);
  return empty;
}

export function recordRolledMovie(movieId: number): RollHistoryState {
  const current = getRollHistory();
  const nextRecent = [...current.recentIds.filter((id) => id !== movieId), movieId].slice(
    -RECENT_HISTORY_LIMIT,
  );
  const uniqueSet = new Set(current.uniqueRolledIds);
  uniqueSet.add(movieId);

  const nextState: RollHistoryState = {
    recentIds: nextRecent,
    totalRolledCount: current.totalRolledCount + 1,
    uniqueRolledIds: Array.from(uniqueSet),
  };
  saveRollHistory(nextState);
  return nextState;
}

// --- Winner Details (Genre & Runtime from ./data/movies.json) ---

export function readCachedMovieDetails(movie: MovieRecord): MovieDetails | null {
  if (movie.isPreviewFallback || movie.id <= 0) return null;

  const mediaType: 'movie' | 'tv' = movie.media_type === 'tv' ? 'tv' : 'movie';
  const embeddedGenre =
    typeof movie.genre === 'string' && movie.genre.trim() ? movie.genre.trim() : null;
  const embeddedRuntime =
    mediaType === 'movie' && typeof movie.runtime === 'number' && movie.runtime > 0
      ? Math.round(movie.runtime)
      : null;

  if (embeddedGenre || embeddedRuntime || mediaType === 'tv') {
    return {
      genre: embeddedGenre,
      runtime: embeddedRuntime,
      mediaType,
    };
  }

  return null;
}
