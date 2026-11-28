#!/usr/bin/env node
/**
 * Daily Letterboxd watchlist sync script (Node 22+, zero external dependencies).
 *
 * Fetches https://letterboxd.com/ruche794/watchlist/page/N/ across all pages,
 * compares against previous movies.json from the watchlist-data branch
 * (falling back to public/data/movies.json), resolves new films via TMDB
 * (movie search with year -> without year -> TV search, plus details for genre/runtime),
 * removes films no longer on the watchlist, only rewrites movies.json when
 * something changed (or when seeding an empty output directory), and ALWAYS writes
 * version.json ({ updated, checked, count }) on every successful run.
 *
 * Requires: process.env.TMDB_API_KEY (never written to disk or logged).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const HAS_CUSTOM_DATA_DIR = Boolean(process.env.WATCHLIST_DATA_DIR?.trim());
const OUTPUT_DIR = HAS_CUSTOM_DATA_DIR
  ? path.resolve(process.env.WATCHLIST_DATA_DIR.trim())
  : path.join(ROOT_DIR, 'public', 'data');
const MOVIES_PATH = path.join(OUTPUT_DIR, 'movies.json');
const VERSION_PATH = path.join(OUTPUT_DIR, 'version.json');
const FALLBACK_MOVIES_PATH = path.join(ROOT_DIR, 'public', 'data', 'movies.json');
const FALLBACK_VERSION_PATH = path.join(ROOT_DIR, 'public', 'data', 'version.json');
const WATCHLIST_BRANCH = 'watchlist-data';

const LETTERBOXD_USER = 'ruche794';
const LETTERBOXD_PAGE_DELAY_MS = 1500;
const MAX_PAGES = 100;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_REQUEST_DELAY_MS = 140;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeHtmlEntities(str) {
  if (!str) return '';
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    ndash: '-',
    mdash: '-',
    hellip: '...',
  };
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return named[entity] ?? full;
  });
}

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitDisplayName(displayName) {
  const cleaned = decodeHtmlEntities(displayName).trim();
  const match = cleaned.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) {
    return {
      title: match[1].trim(),
      year: match[2],
    };
  }
  return {
    title: cleaned,
    year: '',
  };
}

function extractYear(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 4) return '';
  const y = dateStr.slice(0, 4);
  return /^\d{4}$/.test(y) ? y : '';
}

/**
 * Extracts poster items from Letterboxd watchlist HTML.
 * Supports attribute ordering variations and both current (data-item-*) and legacy (data-film-*) attributes.
 */
function parseLetterboxdPage(html) {
  const films = [];
  const tagRegex = /<[^>]+data-item-full-display-name\s*=\s*["'][^"']+["'][^>]*>/gi;
  let tagMatch;

  while ((tagMatch = tagRegex.exec(html)) !== null) {
    const tag = tagMatch[0];
    const nameMatch = tag.match(/data-item-full-display-name\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const slugMatch = tag.match(/data-item-slug\s*=\s*(?:"([^"]*)"|'([^']*)')/i);

    const rawDisplayName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? '') : '';
    const slug = decodeHtmlEntities(slugMatch ? (slugMatch[1] ?? slugMatch[2] ?? '') : '').trim();
    if (!rawDisplayName) continue;

    const { title, year } = splitDisplayName(rawDisplayName);
    if (!title) continue;

    films.push({ title, year, slug });
  }

  return films;
}

async function fetchLetterboxdWatchlist() {
  const allFilms = [];
  const seenKeys = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) {
      await sleep(LETTERBOXD_PAGE_DELAY_MS);
    }

    const url = `https://letterboxd.com/${LETTERBOXD_USER}/watchlist/page/${page}/`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Letterboxd returned HTTP ${res.status} on page ${page}`);
    }

    const html = await res.text();
    if (!html || html.length < 500) {
      throw new Error(`Letterboxd returned an unexpectedly empty body on page ${page}`);
    }

    // Detect Cloudflare / bot-block challenge pages
    if (
      /Just a moment\.\.\.|Attention Required!\s*\|\s*Cloudflare|cf-browser-verification/i.test(
        html,
      )
    ) {
      throw new Error(`Letterboxd blocked request (Cloudflare challenge) on page ${page}`);
    }

    const pageFilms = parseLetterboxdPage(html);
    console.log(`Page ${page}: found ${pageFilms.length} films`);

    if (pageFilms.length === 0) {
      if (page === 1) {
        throw new Error('Letterboxd page 1 returned 0 films — aborting to protect existing list.');
      }
      break;
    }

    for (const film of pageFilms) {
      const key = film.slug || `${normalizeTitle(film.title)}::${film.year}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allFilms.push(film);
    }
  }

  return allFilms;
}

async function tmdbFetchJson(endpointPath, params, apiKey) {
  const url = new URL(`${TMDB_BASE_URL}${endpointPath}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2;
      await sleep((retryAfter + 0.5) * 1000);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`TMDB authentication failed (HTTP ${res.status}) for ${endpointPath}`);
      err.fatal = true;
      throw err;
    }

    if (!res.ok) {
      throw new Error(`TMDB HTTP ${res.status} for ${endpointPath}`);
    }

    return res.json();
  }

  throw new Error(`TMDB rate-limit retries exhausted for ${endpointPath}`);
}

function pickBestTmdbResult(results, targetTitle, targetYear, isTv) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const withPoster = results.filter((r) => typeof r?.poster_path === 'string' && r.poster_path);
  if (withPoster.length === 0) return null;

  const normTarget = normalizeTitle(targetTitle);
  const yearNum = targetYear ? Number.parseInt(targetYear, 10) : NaN;

  let best = withPoster[0];
  let bestScore = -Infinity;

  for (let i = 0; i < withPoster.length; i++) {
    const item = withPoster[i];
    const itemTitle = isTv ? item.name || item.original_name : item.title || item.original_title;
    const normItem = normalizeTitle(itemTitle);
    const itemYear = extractYear(isTv ? item.first_air_date : item.release_date);
    const itemYearNum = itemYear ? Number.parseInt(itemYear, 10) : NaN;

    let score = -i * 1.5;
    if (normItem === normTarget) score += 100;
    else if (normItem.includes(normTarget) || normTarget.includes(normItem)) score += 35;

    if (Number.isFinite(yearNum) && Number.isFinite(itemYearNum)) {
      const diff = Math.abs(yearNum - itemYearNum);
      if (diff === 0) score += 60;
      else if (diff === 1) score += 25;
      else score -= diff * 5;
    }

    if (typeof item.popularity === 'number') {
      score += Math.min(20, Math.log1p(Math.max(0, item.popularity)) * 4);
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

async function lookupFilmOnTmdb(film, apiKey) {
  let match = null;
  let mediaType = 'movie';

  // 1. /search/movie with title + year
  if (film.year) {
    const data = await tmdbFetchJson(
      '/search/movie',
      { query: film.title, year: film.year, include_adult: 'false' },
      apiKey,
    );
    match = pickBestTmdbResult(data.results, film.title, film.year, false);
    await sleep(TMDB_REQUEST_DELAY_MS);
  }

  // 2. Fallback: /search/movie without year
  if (!match) {
    const data = await tmdbFetchJson(
      '/search/movie',
      { query: film.title, include_adult: 'false' },
      apiKey,
    );
    match = pickBestTmdbResult(data.results, film.title, film.year, false);
    await sleep(TMDB_REQUEST_DELAY_MS);
  }

  // 3. Fallback: /search/tv (with year, then without year)
  if (!match) {
    mediaType = 'tv';
    if (film.year) {
      const data = await tmdbFetchJson(
        '/search/tv',
        { query: film.title, first_air_date_year: film.year, include_adult: 'false' },
        apiKey,
      );
      match = pickBestTmdbResult(data.results, film.title, film.year, true);
      await sleep(TMDB_REQUEST_DELAY_MS);
    }
    if (!match) {
      const data = await tmdbFetchJson(
        '/search/tv',
        { query: film.title, include_adult: 'false' },
        apiKey,
      );
      match = pickBestTmdbResult(data.results, film.title, film.year, true);
      await sleep(TMDB_REQUEST_DELAY_MS);
    }
  }

  if (!match || !match.poster_path) {
    return null;
  }

  // Fetch details for primary genre + runtime
  let genre = null;
  let runtime = null;
  try {
    const detailPath = mediaType === 'tv' ? `/tv/${match.id}` : `/movie/${match.id}`;
    const details = await tmdbFetchJson(detailPath, {}, apiKey);
    await sleep(TMDB_REQUEST_DELAY_MS);

    if (Array.isArray(details.genres) && details.genres.length > 0 && details.genres[0]?.name) {
      genre = String(details.genres[0].name).trim();
    }
    if (mediaType === 'movie' && typeof details.runtime === 'number' && details.runtime > 0) {
      runtime = Math.round(details.runtime);
    }
  } catch (err) {
    console.warn(`Warning: failed to fetch TMDB details for "${film.title}" (${match.id}): ${err.message}`);
  }

  const record = {
    id: match.id,
    title: (mediaType === 'tv' ? match.name : match.title) || film.title,
    year:
      film.year ||
      extractYear(mediaType === 'tv' ? match.first_air_date : match.release_date) ||
      '',
    poster_path: match.poster_path,
    overview: typeof match.overview === 'string' ? match.overview : '',
    vote_average: typeof match.vote_average === 'number' ? match.vote_average : 0,
    media_type: mediaType,
  };

  if (genre) record.genre = genre;
  if (mediaType === 'movie' && runtime) record.runtime = runtime;

  return record;
}

function buildExistingMatcher(existingMovies) {
  const byTitleYear = new Map();
  const byTitle = new Map();

  for (const movie of existingMovies) {
    const normTitle = normalizeTitle(movie.title);
    const year = String(movie.year || '').trim();
    const tyKey = `${normTitle}::${year}`;
    if (!byTitleYear.has(tyKey)) {
      byTitleYear.set(tyKey, movie);
    }
    if (!byTitle.has(normTitle)) {
      byTitle.set(normTitle, []);
    }
    byTitle.get(normTitle).push(movie);
  }

  return function findExisting(film) {
    const normTitle = normalizeTitle(film.title);
    const year = String(film.year || '').trim();

    // 1. Exact normalized title + year
    const exact = byTitleYear.get(`${normTitle}::${year}`);
    if (exact) return exact;

    const sameTitle = byTitle.get(normTitle);
    if (!sameTitle || sameTitle.length === 0) return null;

    // 2. Same title within +/- 1 year (common festival vs theatrical release delta between Letterboxd and TMDB)
    const yearNum = year ? Number.parseInt(year, 10) : NaN;
    if (Number.isFinite(yearNum)) {
      const nearYear = sameTitle.find((m) => {
        const mYear = Number.parseInt(String(m.year || ''), 10);
        return Number.isFinite(mYear) && Math.abs(mYear - yearNum) <= 1;
      });
      if (nearYear) return nearYear;
    }

    // 3. Unique title match if no year or single entry with same title
    if (!year && sameTitle.length === 1) {
      return sameTitle[0];
    }

    return null;
  };
}

function recordKey(movie) {
  const mediaType = movie.media_type === 'tv' ? 'tv' : 'movie';
  return `${mediaType}:${movie.id}`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFileIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readJsonFromWatchlistBranch(filename) {
  const refs = [`origin/${WATCHLIST_BRANCH}`, WATCHLIST_BRANCH];
  for (const ref of refs) {
    try {
      const raw = execFileSync('git', ['show', `${ref}:${filename}`], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (raw && raw.trim()) {
        return { data: JSON.parse(raw), source: `git:${ref}:${filename}` };
      }
    } catch {
      // Branch or file doesn't exist in git; continue to next source
    }
  }
  return null;
}

async function loadPreviousData(filename, outputPath, fallbackPath) {
  // 1. If running against a dedicated WATCHLIST_DATA_DIR (the watchlist-data branch worktree), read from it first
  if (HAS_CUSTOM_DATA_DIR) {
    const fromOutput = await readJsonFileIfExists(outputPath);
    if (fromOutput !== null) {
      return { data: fromOutput, source: outputPath };
    }
  }

  // 2. Try reading directly from the watchlist-data git branch (for local runs or unseeded worktrees)
  const fromBranch = readJsonFromWatchlistBranch(filename);
  if (fromBranch !== null) {
    return fromBranch;
  }

  // 3. Fallback to public/data/<filename>
  const fromFallback = await readJsonFileIfExists(fallbackPath);
  if (fromFallback !== null) {
    return { data: fromFallback, source: fallbackPath };
  }

  return { data: null, source: null };
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY?.trim();

  // Load previous movies.json and version.json from watchlist-data branch (fallback: public/data/*)
  const prevMoviesRes = await loadPreviousData('movies.json', MOVIES_PATH, FALLBACK_MOVIES_PATH);
  const existingMovies = Array.isArray(prevMoviesRes.data) ? prevMoviesRes.data : [];

  const prevVersionRes = await loadPreviousData('version.json', VERSION_PATH, FALLBACK_VERSION_PATH);
  const previousVersion =
    prevVersionRes.data && typeof prevVersionRes.data === 'object' ? prevVersionRes.data : null;

  console.log(
    `Loaded ${existingMovies.length} existing movies from ${prevMoviesRes.source ?? 'none (starting fresh)'}`,
  );

  // Scrape Letterboxd watchlist
  let scrapedFilms;
  try {
    scrapedFilms = await fetchLetterboxdWatchlist();
  } catch (err) {
    console.error(`Aborting without changes — failed to fetch Letterboxd watchlist: ${err.message}`);
    process.exit(1);
  }

  console.log(`Scraped ${scrapedFilms.length} unique films from Letterboxd watchlist.`);

  // Safety guard: abort if scraped count is < 50% of previous count (e.g. partial block/layout change)
  if (existingMovies.length > 0 && scrapedFilms.length < existingMovies.length * 0.5) {
    console.error(
      `Aborting without changes — scraped count (${scrapedFilms.length}) is less than 50% of previous count (${existingMovies.length}).`,
    );
    process.exit(1);
  }

  const findExisting = buildExistingMatcher(existingMovies);
  const matchedExistingKeys = new Set();
  const keptMovies = [];
  const newFilmsToLookup = [];

  for (const film of scrapedFilms) {
    const existing = findExisting(film);
    if (existing) {
      const key = recordKey(existing);
      if (!matchedExistingKeys.has(key)) {
        matchedExistingKeys.add(key);
        keptMovies.push(existing);
      }
    } else {
      newFilmsToLookup.push(film);
    }
  }

  const removedMovies = existingMovies.filter((m) => !matchedExistingKeys.has(recordKey(m)));
  console.log(
    `Comparison: ${keptMovies.length} kept, ${newFilmsToLookup.length} new to look up, ${removedMovies.length} removed.`,
  );

  if (newFilmsToLookup.length > 0 && !apiKey) {
    console.error('Aborting without changes — TMDB_API_KEY environment variable is required to look up new films.');
    process.exit(1);
  }

  const addedMovies = [];
  const skippedNoPoster = [];
  const finalSeenKeys = new Set(keptMovies.map(recordKey));

  for (let i = 0; i < newFilmsToLookup.length; i++) {
    const film = newFilmsToLookup[i];
    try {
      const resolved = await lookupFilmOnTmdb(film, apiKey);
      if (!resolved) {
        skippedNoPoster.push(`${film.title}${film.year ? ` (${film.year})` : ''}`);
        continue;
      }
      const key = recordKey(resolved);
      if (finalSeenKeys.has(key)) continue;
      finalSeenKeys.add(key);
      addedMovies.push(resolved);
      console.log(
        `  + [${i + 1}/${newFilmsToLookup.length}] ${resolved.title} (${resolved.year}) [${resolved.media_type}]`,
      );
    } catch (err) {
      if (err?.fatal) {
        console.error(`Aborting without changes — ${err.message}`);
        process.exit(1);
      }
      console.warn(`  ! Failed TMDB lookup for "${film.title}" (${film.year}): ${err.message}`);
    }
  }

  if (skippedNoPoster.length > 0) {
    console.log(`Skipped ${skippedNoPoster.length} unmatched or posterless titles.`);
  }

  // Final list: newly added films + kept existing films (preserving existing order for stability)
  const nextMovies = [...addedMovies, ...keptMovies];

  // Double safety check before writing
  if (existingMovies.length > 0 && nextMovies.length < existingMovies.length * 0.5) {
    console.error(
      `Aborting without changes — resulting count (${nextMovies.length}) is less than 50% of previous count (${existingMovies.length}).`,
    );
    process.exit(1);
  }

  // Detect whether the film set actually changed
  const prevKeySet = new Set(existingMovies.map(recordKey));
  const nextKeySet = new Set(nextMovies.map(recordKey));
  let hasChanged = prevKeySet.size !== nextKeySet.size;
  if (!hasChanged) {
    for (const k of nextKeySet) {
      if (!prevKeySet.has(k)) {
        hasChanged = true;
        break;
      }
    }
  }

  const nowIso = new Date().toISOString();
  const previousUpdated =
    typeof previousVersion?.updated === 'string' && previousVersion.updated.trim().length > 0
      ? previousVersion.updated.trim()
      : null;

  const finalMovies = hasChanged ? nextMovies : existingMovies;
  const outputMoviesExists = await fileExists(MOVIES_PATH);
  const shouldWriteMovies = hasChanged || !outputMoviesExists;

  const versionPayload = {
    updated: hasChanged ? nowIso : (previousUpdated ?? nowIso),
    checked: nowIso,
    count: finalMovies.length,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  if (shouldWriteMovies) {
    await fs.writeFile(MOVIES_PATH, `${JSON.stringify(finalMovies, null, 2)}\n`, 'utf8');
  }
  await fs.writeFile(VERSION_PATH, `${JSON.stringify(versionPayload, null, 2)}\n`, 'utf8');

  if (hasChanged) {
    console.log(
      `Updated ${MOVIES_PATH} (${finalMovies.length} movies: +${addedMovies.length}, -${removedMovies.length}) and ${VERSION_PATH}.`,
    );
  } else if (!outputMoviesExists) {
    console.log(
      `No watchlist changes detected — seeded ${MOVIES_PATH} (${finalMovies.length} movies) and updated checked timestamp in ${VERSION_PATH}.`,
    );
  } else {
    console.log(
      `No watchlist changes detected — kept existing movies.json and updated checked timestamp in ${VERSION_PATH}.`,
    );
  }
}

main().catch((err) => {
  console.error(`Fatal error in update-watchlist.mjs: ${err.message}`);
  process.exit(1);
});
