import { Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RevealOverlay } from './components/RevealOverlay';
import { SyncScreen } from './components/SyncScreen';
import { UnmatchedDrawer } from './components/UnmatchedDrawer';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  buildWatchlistPreviewMovies,
  clearCachedMovies,
  fetchWatchlistCsv,
  fetchWatchlistVersion,
  readCachedMovieDetails,
  readCachedMovies,
  readStoredWatchlistVersion,
  recordRolledMovie,
  resetRollHistory,
  saveStoredWatchlistVersion,
  tryLoadStaticMoviesJson,
} from './services/tmdbSync';
import {
  clearBakedCollageCache,
  createCleanFallbackPosterDataUrl,
  type BakeProgress,
} from './three/collageBaker';
import {
  MovieDieEngine,
  type FlingVector,
  type GameMode,
  type RevealScreenLayout,
} from './three/MovieDieEngine';
import type {
  MovieDetails,
  MovieRecord,
  SyncProgress,
  UnmatchedEntry,
} from './types/movie';

interface HoverTooltipState {
  movie: MovieRecord;
  x: number;
  y: number;
}

const MODE_STORAGE_KEY = 'movieDieMode_v1';
const SHORT_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

function formatLastUpdated(isoString: string): string | null {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;

  const day = date.getDate();
  const month = SHORT_MONTHS[date.getMonth()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `last updated: ${day} ${month}, ${hh}:${mm}`;
}

function readInitialMode(): GameMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === 'darts' ? 'darts' : 'dice';
  } catch {
    return 'dice';
  }
}

export default function App() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MovieDieEngine | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const fadeClearTimerRef = useRef<number | null>(null);

  const [movies, setMovies] = useState<MovieRecord[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedEntry[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [showPreviewBanner, setShowPreviewBanner] = useState(false);

  const [isSyncing, setIsSyncing] = useState(true);
  const [isBaking, setIsBaking] = useState(false);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(true);
  const [loadingFadingOut, setLoadingFadingOut] = useState(false);
  const loadingFadeTimerRef = useRef<number | null>(null);
  const [bakeProgress, setBakeProgress] = useState<BakeProgress>({
    completed: 0,
    total: 1,
    label: 'Gluing posters…',
  });
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    completed: 0,
    total: 0,
    matched: 0,
    currentTitle: '',
  });
  const [syncError, setSyncError] = useState<string | null>(null);

  const [mode, setMode] = useState<GameMode>(readInitialMode);
  const [dartBusy, setDartBusy] = useState(false);
  const [isRolling, setIsRolling] = useState(false);
  const [isZoomedReveal, setIsZoomedReveal] = useState(false);
  const [revealedMovie, setRevealedMovie] = useState<MovieRecord | null>(null);
  const [revealedDetails, setRevealedDetails] = useState<MovieDetails | null>(null);
  const [revealLayout, setRevealLayout] = useState<RevealScreenLayout | null>(null);
  const [revealSkipped, setRevealSkipped] = useState(false);
  const [revealFadingOut, setRevealFadingOut] = useState(false);
  const [swapMovie, setSwapMovie] = useState<MovieRecord | null>(null);
  const [swapLayout, setSwapLayout] = useState<RevealScreenLayout | null>(null);
  const [swapPhase, setSwapPhase] = useState<'crossfade' | 'settling' | 'settled' | 'closing'>('crossfade');
  const [swapImgSrc, setSwapImgSrc] = useState<string | null>(null);
  const preloadedPosterUrlsRef = useRef<Map<number, string>>(new Map());

  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltipState | null>(null);
  const [muted, setMuted] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutContainerRef = useRef<HTMLDivElement | null>(null);
  const [watchlistUpdatedAt, setWatchlistUpdatedAt] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [shadowBottomY, setShadowBottomY] = useState<number | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1024,
    h: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  const isOnline = useOnlineStatus();

  const moviesRef = useRef<MovieRecord[]>([]);
  const revealedMovieRef = useRef<MovieRecord | null>(null);
  const isZoomedRevealRef = useRef(false);
  const isRollingRef = useRef(false);

  useEffect(() => {
    moviesRef.current = movies;
  }, [movies]);

  useEffect(() => {
    revealedMovieRef.current = revealedMovie;
  }, [revealedMovie]);

  useEffect(() => {
    isZoomedRevealRef.current = isZoomedReveal;
  }, [isZoomedReveal]);

  useEffect(() => {
    isRollingRef.current = isRolling;
  }, [isRolling]);

  useEffect(() => {
    const onResize = () => {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (fadeClearTimerRef.current !== null) {
        clearTimeout(fadeClearTimerRef.current);
      }
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
      if (loadingFadeTimerRef.current !== null) {
        clearTimeout(loadingFadeTimerRef.current);
      }
    };
  }, []);

  const isLoading = isSyncing || isBaking;

  useEffect(() => {
    if (loadingFadeTimerRef.current !== null) {
      clearTimeout(loadingFadeTimerRef.current);
      loadingFadeTimerRef.current = null;
    }

    if (isLoading) {
      setShowLoadingOverlay(true);
      setLoadingFadingOut(false);
      return;
    }

    setLoadingFadingOut(true);
    loadingFadeTimerRef.current = window.setTimeout(() => {
      setShowLoadingOverlay(false);
      setLoadingFadingOut(false);
      loadingFadeTimerRef.current = null;
    }, 620);
  }, [isLoading]);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
    }
    setToastMessage(msg);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const loadStartupData = useCallback(async (forceResync = false) => {
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    setSyncError(null);

    try {
      const remoteVersion = await fetchWatchlistVersion(controller.signal);
      if (controller.signal.aborted) return;

      setWatchlistUpdatedAt(remoteVersion?.checked ?? remoteVersion?.updated ?? null);

      const storedVersion = readStoredWatchlistVersion();
      if (remoteVersion?.updated && storedVersion !== remoteVersion.updated) {
        clearCachedMovies();
        await clearBakedCollageCache();
        if (controller.signal.aborted) return;
      }

      const staticMovies = await tryLoadStaticMoviesJson(controller.signal);
      if (controller.signal.aborted) return;

      if (staticMovies) {
        if (remoteVersion?.updated) {
          saveStoredWatchlistVersion(remoteVersion.updated);
        }
        setMovies(staticMovies);
        setUnmatched([]);
        setIsPreviewMode(false);
        setShowPreviewBanner(false);
        setIsBaking(true);
        setIsSyncing(false);
        return;
      }

      if (!forceResync) {
        const cached = readCachedMovies();
        if (cached) {
          setMovies(cached.movies);
          setUnmatched(cached.unmatched || []);
          setIsPreviewMode(false);
          setShowPreviewBanner(false);
          setIsBaking(true);
          setIsSyncing(false);
          return;
        }
      }

      setIsSyncing(true);
      setSyncProgress({
        completed: 0,
        total: 0,
        matched: 0,
        currentTitle: 'Loading watchlist.csv…',
      });

      const rows = await fetchWatchlistCsv();
      if (controller.signal.aborted) return;

      const previewMovies = buildWatchlistPreviewMovies(rows);
      setMovies(previewMovies);
      setUnmatched([]);
      setIsPreviewMode(true);
      setShowPreviewBanner(true);
      setIsBaking(previewMovies.length > 0);
      setIsSyncing(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Unable to load movies.';
      setSyncError(msg);
      setIsSyncing(true);
    }
  }, []);

  useEffect(() => {
    void loadStartupData(false);
    return () => {
      syncAbortRef.current?.abort();
    };
  }, [loadStartupData]);

  const resolveCleanPosterSrc = useCallback((movie: MovieRecord): string => {
    const cached = preloadedPosterUrlsRef.current.get(movie.id);
    if (cached) return cached;
    if (movie.poster_path && !movie.isPreviewFallback) {
      const url = `https://image.tmdb.org/t/p/original${movie.poster_path}`;
      preloadedPosterUrlsRef.current.set(movie.id, url);
      return url;
    }
    const fallback = createCleanFallbackPosterDataUrl(movie);
    preloadedPosterUrlsRef.current.set(movie.id, fallback);
    return fallback;
  }, []);

  const triggerRoll = useCallback((fling?: FlingVector) => {
    const engine = engineRef.current;
    const list = moviesRef.current;
    if (!engine || list.length === 0 || engine.isBusy() || isRollingRef.current) return;

    engine.roll(fling);
  }, []);

  // Mount Three.js + cannon-es Engine once
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const engine = new MovieDieEngine(container, {
      onHoverMovie: (movieIndex, clientX, clientY) => {
        if (
          movieIndex === null ||
          isRollingRef.current ||
          isZoomedRevealRef.current ||
          revealedMovieRef.current
        ) {
          setHoverTooltip(null);
          return;
        }
        const m = moviesRef.current[movieIndex];
        if (!m) {
          setHoverTooltip(null);
          return;
        }
        setHoverTooltip({ movie: m, x: clientX, y: clientY });
      },
      onRollStarted: () => {
        if (fadeClearTimerRef.current !== null) {
          clearTimeout(fadeClearTimerRef.current);
          fadeClearTimerRef.current = null;
        }
        setIsRolling(true);
        setIsZoomedReveal(false);
        setHoverTooltip(null);
        setAboutOpen(false);
        setRevealedMovie(null);
        setRevealedDetails(null);
        setRevealLayout(null);
        setRevealSkipped(false);
        setRevealFadingOut(false);
        setSwapMovie(null);
        setSwapLayout(null);
        setSwapPhase('crossfade');
        setSwapImgSrc(null);
      },
      onDartActivityChange: (busy) => {
        setDartBusy(busy);
      },
      onZoomStarted: () => {
        setIsRolling(false);
        setDartBusy(false);
        setIsZoomedReveal(true);
        setHoverTooltip(null);
      },
      onPosterLiftStarted: () => {
        // Handled in 3D engine
      },
      onPreloadWinner: (winnerIndex) => {
        const movie = moviesRef.current[winnerIndex];
        if (!movie) return;
        const src = resolveCleanPosterSrc(movie);
        if (movie.poster_path && !movie.isPreviewFallback) {
          const img = new Image();
          img.decoding = 'async';
          img.src = src;
          if (typeof img.decode === 'function') {
            void img.decode().catch(() => {
              // Browser will still render via <img> on mount
            });
          }
        }
      },
      onPosterSwapStarted: (winnerIndex, layout, skipped) => {
        const winner = moviesRef.current[winnerIndex];
        if (!winner) return;
        setSwapMovie(winner);
        setSwapLayout(layout);
        setSwapPhase(skipped ? 'settled' : 'crossfade');
        setSwapImgSrc(resolveCleanPosterSrc(winner));
      },
      onPosterSettleStarted: () => {
        setSwapPhase('settling');
      },
      onRevealReady: (winnerIndex, layout, skipped) => {
        if (fadeClearTimerRef.current !== null) {
          clearTimeout(fadeClearTimerRef.current);
          fadeClearTimerRef.current = null;
        }
        const winner = moviesRef.current[winnerIndex];
        if (winner) {
          // Keep background no-repeat roll history updated
          recordRolledMovie(winner.id);
          setRevealedDetails(readCachedMovieDetails(winner));
          setRevealedMovie(winner);
          setRevealLayout(layout);
          setRevealSkipped(Boolean(skipped));
          setRevealFadingOut(false);
          setSwapMovie(winner);
          setSwapLayout(layout);
          setSwapPhase('settled');
          setSwapImgSrc((prev) => prev ?? resolveCleanPosterSrc(winner));
        }
      },
      onRevealLayoutChange: (layout) => {
        setRevealLayout(layout);
        setSwapLayout(layout);
      },
      onReturnComplete: () => {
        if (fadeClearTimerRef.current !== null) {
          clearTimeout(fadeClearTimerRef.current);
          fadeClearTimerRef.current = null;
        }
        setIsZoomedReveal(false);
        setRevealedMovie(null);
        setRevealedDetails(null);
        setRevealLayout(null);
        setRevealFadingOut(false);
        setSwapMovie(null);
        setSwapLayout(null);
        setSwapPhase('crossfade');
        setSwapImgSrc(null);
      },
      onFlingRollRequest: (fling) => {
        triggerRoll(fling);
      },
      onContextLostChange: (lost) => {
        setContextLost(lost);
      },
      onShadowBottomChange: (bottomY) => {
        setShadowBottomY(bottomY);
      },
    });

    engineRef.current = engine;
    engine.setMode(readInitialMode());

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [resolveCleanPosterSrc, triggerRoll]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || movies.length === 0) return;
    let cancelled = false;

    setIsBaking(true);
    setBakeProgress({ completed: 0, total: movies.length * 2, label: 'Gluing posters…' });

    void engine
      .setMovies(movies, (prog) => {
        if (!cancelled) setBakeProgress(prog);
      })
      .then(() => {
        if (!cancelled) setIsBaking(false);
      })
      .catch(() => {
        if (!cancelled) setIsBaking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [movies]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore
    }
    engineRef.current?.setMode(mode);
  }, [mode]);

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'dice' ? 'darts' : 'dice'));
  }, []);

  const handleRollAgain = useCallback(() => {
    setRevealFadingOut(true);
    setSwapPhase('closing');
    engineRef.current?.closeRevealAndReturn();
  }, []);

  const handleResync = useCallback(async () => {
    clearCachedMovies();
    await clearBakedCollageCache();
    await loadStartupData(true);
  }, [loadStartupData]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'r') {
        e.preventDefault();
        showToast('re-syncing…');
        handleResync();
      } else if (key === 'h') {
        e.preventDefault();
        resetRollHistory();
        showToast('history cleared');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleResync, showToast]);

  useEffect(() => {
    if (!aboutOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!aboutContainerRef.current?.contains(e.target as Node)) {
        setAboutOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAboutOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [aboutOpen]);

  const handleUsePreviewFallback = useCallback(async () => {
    try {
      const rows = await fetchWatchlistCsv();
      const previewMovies = buildWatchlistPreviewMovies(rows);
      setMovies(previewMovies);
      setUnmatched([]);
      setIsPreviewMode(true);
      setShowPreviewBanner(true);
      setSyncError(null);
      setIsBaking(previewMovies.length > 0);
      setIsSyncing(false);
    } catch {
      // Keep error screen if CSV itself failed
    }
  }, []);

  const hideChromeForReveal = isZoomedReveal || Boolean(revealedMovie) || Boolean(swapMovie);
  const isMobileViewport = viewportSize.w < 768;
  const stackLastUpdated = viewportSize.w < 460;
  const lastUpdatedLabel = watchlistUpdatedAt ? formatLastUpdated(watchlistUpdatedAt) : null;
  const estimatedHintHeight = mode === 'darts' ? 24 : isMobileViewport ? 32 : 44;
  const minBottomClearance = isMobileViewport ? 120 : 28;
  const maxHintTop = Math.max(150, viewportSize.h - minBottomClearance - estimatedHintHeight);
  const hintTopPx = Math.max(
    150,
    Math.min(shadowBottomY !== null ? shadowBottomY + 24 : maxHintTop, maxHintTop),
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-white text-[#111215] select-none">
      {/* Dedicated WebGL Canvas Container */}
      <div ref={canvasContainerRef} className="absolute inset-0 h-full w-full" />

      {/* WebGL Context Lost Fallback */}
      {contextLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/95 p-6 text-center">
          <div className="max-w-sm">
            <p className="text-xl font-bold text-[#111215]">Graphics context interrupted</p>
            <p className="mt-2 text-sm text-[#555555]">Restoring the 3D view…</p>
          </div>
        </div>
      )}

      {/* Top Header: Centered Hand-Drawn Title + Darts Mode Toggle under "dice" (nothing in top-right) */}
      {!isSyncing && !isBaking && (
        <header
          className={`pointer-events-none fixed inset-x-0 top-0 z-20 px-4 pt-3.5 sm:px-7 sm:pt-6 overflow-visible transition-opacity duration-500 ${
            hideChromeForReveal ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <div className="mx-auto flex justify-center text-center overflow-visible">
            <div
              className={`relative inline-block max-w-full overflow-visible ${
                hideChromeForReveal ? 'pointer-events-none' : 'pointer-events-auto'
              }`}
            >
              <h1 className="m-0">
                <img
                  src="./assets/luis-title.png"
                  alt="Luis's big movie dice"
                  className="block h-auto w-[min(calc(100vw-32px),440px)] sm:h-[90px] sm:w-auto sm:max-w-[82vw] select-none"
                  draggable={false}
                />
              </h1>

              <button
                type="button"
                onClick={toggleMode}
                aria-pressed={mode === 'darts'}
                aria-label={mode === 'darts' ? 'Switch to dice mode' : 'Switch to darts mode'}
                title={mode === 'darts' ? 'Switch to dice mode' : 'Switch to darts mode'}
                className="mode-btn absolute right-0 top-[calc(100%+6px)] sm:top-[calc(100%+8px)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black rounded-xs"
              >
                <img
                  src="./assets/darts-mode.png"
                  alt="darts mode"
                  draggable={false}
                  className={`h-[28px] sm:h-[36px] w-auto object-contain select-none transition-opacity duration-200 ${
                    mode === 'darts' ? 'opacity-100' : 'opacity-60'
                  }`}
                />
                {mode === 'darts' && (
                  <svg
                    viewBox="0 0 120 10"
                    fill="none"
                    aria-hidden="true"
                    className="pointer-events-none mt-[1px] h-[8px] w-full overflow-visible"
                  >
                    <path
                      d="M2 5.5 C24 3.2, 46 7.4, 70 4.8 C92 2.9, 108 6.4, 118 4.4"
                      stroke="#000000"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Preview Mode Reminder */}
      {!isSyncing &&
        !isBaking &&
        isPreviewMode &&
        showPreviewBanner &&
        !hideChromeForReveal &&
        !isRolling && (
          <div className="pointer-events-auto fixed top-24 left-1/2 -translate-x-1/2 z-20 flex max-w-[92vw] items-center gap-3 rounded-lg border border-black/12 bg-white/95 px-4 py-2 text-xs text-[#2B2D35] shadow-sm">
            <span>
              Add <code className="font-semibold text-black">./data/movies.json</code> to load official posters.
            </span>
            <button
              type="button"
              onClick={() => setShowPreviewBanner(false)}
              aria-label="Dismiss notice"
              className="text-[#6E727D] hover:text-black"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

      {/* Face Hover Tooltip */}
      {hoverTooltip && !isRolling && !hideChromeForReveal && (
        <div
          className="pointer-events-none fixed z-30 rounded-md border border-black/12 bg-white/96 px-3 py-1.5 shadow-lg"
          style={{
            left: Math.min(window.innerWidth - 220, Math.max(12, hoverTooltip.x + 14)),
            top: Math.max(12, hoverTooltip.y - 38),
          }}
        >
          <span className="text-xs font-medium text-[#111215]">{hoverTooltip.movie.title}</span>
          {hoverTooltip.movie.year && (
            <span className="ml-2 text-[11px] font-normal text-[#6E727D] tabular-nums">
              {hoverTooltip.movie.year}
            </span>
          )}
        </div>
      )}

      {/* Hand-Drawn Hint positioned ~24px below the ball's shadow (never lower than 120px from bottom on mobile) */}
      {!isSyncing && !isBaking && (
        <footer
          style={{ top: `${hintTopPx}px` }}
          className={`pointer-events-none fixed inset-x-0 z-20 flex flex-col items-center px-4 transition-opacity duration-500 ${
            hideChromeForReveal ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <div
            className={`transition-opacity duration-300 ${
              isRolling || dartBusy ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {mode === 'darts' ? (
              <p className="animate-hint-bob text-[13px] sm:text-[15px] font-medium tracking-wide text-[#555862]">
                pull back &amp; release to throw
              </p>
            ) : (
              <img
                src="./assets/click-drag-hint.png"
                alt="click & drag to start"
                draggable={false}
                className="animate-hint-bob h-[32px] sm:h-[44px] w-auto object-contain select-none"
              />
            )}
          </div>
        </footer>
      )}

      {/* Bottom-Left Controls: Subtle Sound Toggle above About Link & Attribution Popover */}
      {!isSyncing && !isBaking && (
        <div
          ref={aboutContainerRef}
          style={{
            left: '16px',
            bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          }}
          className={`fixed z-30 flex flex-col items-start gap-0.5 transition-opacity duration-500 ${
            hideChromeForReveal ? 'pointer-events-none opacity-0' : 'pointer-events-auto opacity-100'
          }`}
        >
          {aboutOpen && (
            <div
              id="about-popover"
              role="dialog"
              aria-label="About Luis's Big Movie Dice"
              className="absolute bottom-full left-0 mb-2.5 w-[264px] sm:w-[292px] rounded-xl border border-black/10 bg-white p-4 text-[12px] leading-relaxed text-[#4E525D] shadow-[0_10px_30px_rgba(0,0,0,0.09)]"
            >
              <p className="text-[#111215]">
                made by livy · movie data &amp; posters from TMDB.
              </p>
              <p className="mt-1.5">
                This product uses the TMDB API but is not endorsed or certified by TMDB.
              </p>
              <a
                href="https://www.themoviedb.org/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="The Movie Database (TMDB)"
                className="mt-3 inline-block opacity-90 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black rounded-xs"
              >
                <img
                  src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
                  alt="TMDB"
                  className="h-[14px] w-auto"
                />
              </a>
            </div>
          )}

          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? 'Unmute sound effects' : 'Mute sound effects'}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
            className="flex h-10 w-10 items-center justify-start rounded-lg border-0 bg-transparent p-0 text-[#9a9da6] transition-colors duration-150 hover:text-[#4E525D] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-black/40 cursor-pointer"
          >
            {muted ? <VolumeX className="h-[18px] w-[18px]" /> : <Volume2 className="h-[18px] w-[18px]" />}
          </button>

          {lastUpdatedLabel && stackLastUpdated && (
            <span className="font-luis-hand whitespace-nowrap text-[15px] leading-tight text-[#999999] select-none">
              {lastUpdatedLabel}
            </span>
          )}

          <div className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => setAboutOpen((open) => !open)}
              aria-expanded={aboutOpen}
              aria-controls="about-popover"
              className="shrink-0 bg-transparent border-0 p-0 text-[11px] font-normal text-[#bbbbbb] opacity-50 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-black/40 rounded-xs cursor-pointer"
            >
              about
            </button>

            {lastUpdatedLabel && !stackLastUpdated && (
              <>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[11px] text-[#bbbbbb] opacity-60 select-none"
                >
                  ·
                </span>
                <span className="font-luis-hand whitespace-nowrap text-[15px] sm:text-[18px] leading-none text-[#999999] select-none">
                  {lastUpdatedLabel}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Dismissible Unmatched Titles List */}
      {showUnmatched && !isSyncing && !isBaking && (
        <UnmatchedDrawer
          unmatched={unmatched}
          onDismiss={() => setShowUnmatched(false)}
        />
      )}

      {/* Clean Original Poster Swap Overlay (exact 2:3 screen rect, sharp corners, behind dialog, above 3D scene) */}
      {swapMovie && swapLayout && swapImgSrc && (
        <img
          key={`clean-poster-${swapMovie.id}`}
          src={swapImgSrc}
          alt={swapMovie.title}
          draggable={false}
          onError={() => {
            if (
              swapMovie.poster_path &&
              !swapMovie.isPreviewFallback &&
              swapImgSrc.includes('/t/p/original')
            ) {
              const w780Url = `https://image.tmdb.org/t/p/w780${swapMovie.poster_path}`;
              preloadedPosterUrlsRef.current.set(swapMovie.id, w780Url);
              setSwapImgSrc(w780Url);
              return;
            }
            const fallback = createCleanFallbackPosterDataUrl(swapMovie);
            if (swapImgSrc !== fallback) {
              preloadedPosterUrlsRef.current.set(swapMovie.id, fallback);
              setSwapImgSrc(fallback);
            }
          }}
          style={{
            left: `${swapLayout.posterLeft}px`,
            top: `${swapLayout.posterTop}px`,
            width: `${swapLayout.posterWidth}px`,
            height: `${swapLayout.posterHeight}px`,
          }}
          className={`pointer-events-none fixed z-[26] select-none rounded-none object-cover shadow-[0_18px_46px_rgba(0,0,0,0.22),0_4px_12px_rgba(0,0,0,0.10)] ${
            swapPhase === 'closing'
              ? 'animate-clean-poster-out'
              : swapPhase === 'settling'
                ? 'animate-clean-poster-settle'
                : swapPhase === 'settled'
                  ? 'opacity-100 scale-100'
                  : 'animate-clean-poster-in'
          }`}
        />
      )}

      {/* In-Scene Typography Overlay beside/below the zoomed winning poster */}
      {revealedMovie && revealLayout && (
        <RevealOverlay
          movie={revealedMovie}
          details={revealedDetails}
          layout={revealLayout}
          isFadingOut={revealFadingOut}
          skipInitialPause={revealSkipped}
          actionLabel={mode === 'darts' ? 'Throw again' : 'Roll again'}
          onRollAgain={handleRollAgain}
        />
      )}

      {/* Sync / Collage Baking Screen (fades out smoothly over 0.6s into the main screen) */}
      {showLoadingOverlay && (
        <SyncScreen
          isBaking={isBaking}
          isFadingOut={loadingFadingOut}
          bakeProgress={bakeProgress}
          progress={syncProgress}
          errorMessage={syncError}
          onRetry={() => void loadStartupData(true)}
          onUsePreview={() => void handleUsePreviewFallback()}
        />
      )}

      {/* Subtle Offline Mode Indicator */}
      {!isOnline && (
        <div
          role="status"
          aria-live="polite"
          style={{
            right: '16px',
            bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          }}
          className="pointer-events-none fixed z-40 flex items-center gap-2 rounded-lg border border-black/12 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-[#4E525D] shadow-sm"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Offline — using cached data
        </div>
      )}

      {/* Subtle Toast for Hidden Shortcuts */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-[#111215] px-3.5 py-1.5 text-xs font-medium tracking-wide text-white shadow-md"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
