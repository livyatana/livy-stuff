import type { BakeProgress } from '../three/collageBaker';
import type { SyncProgress } from '../types/movie';

interface SyncScreenProps {
  isBaking: boolean;
  bakeProgress: BakeProgress;
  progress: SyncProgress;
  errorMessage: string | null;
  onRetry: () => void;
  onUsePreview: () => void;
}

export function SyncScreen({
  isBaking,
  bakeProgress,
  progress,
  errorMessage,
  onRetry,
  onUsePreview,
}: SyncScreenProps) {
  const pct = isBaking
    ? bakeProgress.total > 0
      ? Math.min(100, Math.round((bakeProgress.completed / bakeProgress.total) * 100))
      : 0
    : progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="font-hand text-4xl sm:text-5xl tracking-tight text-black">
          luis&apos;s big movie dice
        </h1>

        {errorMessage ? (
          <div className="mt-6 rounded-xl border border-black/12 bg-[#FAFAFA] p-6 text-left shadow-sm">
            <p className="text-sm font-semibold text-[#111215]">TMDB Sync Interrupted</p>
            <p className="mt-2 text-sm leading-relaxed text-[#5A5E69]">{errorMessage}</p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onRetry}
                className="h-10 rounded-lg bg-[#111215] px-4 text-sm font-semibold text-white whitespace-nowrap transition-colors hover:bg-black"
              >
                Retry sync
              </button>
              <button
                type="button"
                onClick={onUsePreview}
                className="h-10 rounded-lg border border-black/15 bg-white px-4 text-sm font-medium text-[#111215] whitespace-nowrap transition-colors hover:border-black/30"
              >
                Launch watchlist preview
              </button>
            </div>
          </div>
        ) : isBaking ? (
          <div className="mt-8">
            <p className="tabular-nums text-sm text-[#2B2D35]">
              {bakeProgress.label || 'Gluing posters…'}
            </p>

            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className="h-full rounded-full bg-[#111215] transition-[width] duration-150 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-[#6E727D]">
              <span>Building paper collage cube map</span>
              <span className="tabular-nums shrink-0">{pct}%</span>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <p className="tabular-nums text-sm text-[#2B2D35]">
              {progress.total > 0
                ? `Matching ${progress.completed} / ${progress.total} films…`
                : 'Loading watchlist…'}
            </p>

            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className="h-full rounded-full bg-[#111215] transition-[width] duration-150 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-[#6E727D]">
              <span className="truncate max-w-[260px]">
                {progress.currentTitle || 'Preparing TMDB queue…'}
              </span>
              <span className="tabular-nums shrink-0">{progress.matched} matched</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
