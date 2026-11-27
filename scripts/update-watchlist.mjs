#!/usr/bin/env node
/**
 * Daily Letterboxd watchlist sync script (Node 22+, zero external dependencies).
 *
 * Fetches https://letterboxd.com/ruche794/watchlist/page/N/ across all pages,
 * compares against public/data/movies.json, resolves new films via TMDB
 * (movie search with year -> without year -> TV search, plus details for genre/runtime),
 * removes films no longer on the watchlist, and writes public/data/movies.json
 * and public/data/version.json only when changes are detected.
 *
 * Requires: process.env.TMDB_API_KEY (never written to disk or logged).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MOVIES_PATH = path.join(ROOT_DIR, 'public', 'data', 'movies.json');
const VERSION_PATH = path.join(ROOT_DIR, 'public', 'data', 'version.json');

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

async function main() {
  const apiKey = process.env.TMDB_API_KEY?.trim();

  // Load existing movies.json
  let existingMovies = [];
  try {
    const raw = await fs.readFile(MOVIES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      existingMovies = parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  console.log(`Loaded ${existingMovies.length} existing movies from public/data/movies.json`);

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

  if (!hasChanged) {
    console.log('No watchlist changes detected — exiting without writing.');
    return;
  }

  const versionPayload = {
    updated: new Date().toISOString(),
    count: nextMovies.length,
  };

  await fs.mkdir(path.dirname(MOVIES_PATH), { recursive: true });
  await fs.writeFile(MOVIES_PATH, `${JSON.stringify(nextMovies, null, 2)}\n`, 'utf8');
  await fs.writeFile(VERSION_PATH, `${JSON.stringify(versionPayload, null, 2)}\n`, 'utf8');

  console.log(
    `Updated public/data/movies.json (${nextMovies.length} movies: +${addedMovies.length}, -${removedMovies.length}) and public/data/version.json.`,
  );
}

main().catch((err) => {
  console.error(`Fatal error in update-watchlist.mjs: ${err.message}`);
  process.exit(1);
});
