import { useId } from 'react';
import type { BakeProgress } from '../three/collageBaker';
import type { SyncProgress } from '../types/movie';

interface SyncScreenProps {
  isBaking: boolean;
  isFadingOut?: boolean;
  bakeProgress: BakeProgress;
  progress: SyncProgress;
  errorMessage: string | null;
  onRetry: () => void;
  onUsePreview: () => void;
}

const HAND_DRAWN_BAR_PATH =
  'M 10 5.4 C 74 3.9, 138 6.3, 206 4.7 C 266 3.5, 312 5.9, 349.5 5.1 Q 355.5 5.2, 355.2 13.8 Q 355.8 22.4, 349.2 22.9 C 292 24.3, 232 21.7, 168 23.4 C 108 24.8, 56 22.2, 10.6 23.1 Q 4.6 22.9, 5.1 14.2 Q 4.4 5.9, 10 5.4 Z';

function HandDrawnProgressBar({ pct }: { pct: number }) {
  const clipId = useId();
  const clamped = Math.max(0, Math.min(100, pct));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="mt-4 w-full"
    >
      <svg
        viewBox="0 0 360 28"
        fill="none"
        preserveAspectRatio="none"
        className="block h-[26px] sm:h-[28px] w-full overflow-visible"
      >
        <defs>
          <clipPath id={clipId}>
            <path d={HAND_DRAWN_BAR_PATH} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <rect
            x="3"
            y="2"
            width="354"
            height="24"
            fill="#111215"
            style={{
              transform: `scaleX(${clamped / 100})`,
              transformOrigin: '3px 14px',
              transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        </g>

        <path
          d={HAND_DRAWN_BAR_PATH}
          fill="none"
          stroke="#111215"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function SyncScreen({
  isBaking,
  isFadingOut = false,
  bakeProgress,
  progress,
  errorMessage,
  onRetry,
  onUsePreview,
}: SyncScreenProps) {
  const showBakingState = isBaking || isFadingOut;

  const pct = isFadingOut
    ? 100
    : isBaking
      ? bakeProgress.total > 0
        ? Math.min(100, Math.round((bakeProgress.completed / bakeProgress.total) * 100))
        : 0
      : progress.total > 0
        ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
        : 0;

  const headingLabel = showBakingState
    ? bakeProgress.label || 'Gluing posters…'
    : progress.total > 0
      ? `Matching ${progress.completed} / ${progress.total} films…`
      : 'Gluing posters…';

  const stepLabel = showBakingState
    ? 'Building paper collage cube map'
    : progress.currentTitle || 'Loading watchlist…';

  const rightStat = `${pct}%`;

  return (
    <div
      aria-hidden={isFadingOut}
      className={`fixed inset-0 z-50 bg-white transition-opacity duration-[600ms] ease-out ${
        isFadingOut ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      {/* Identical title size & position to main screen so there is zero jump on fade-out */}
      <header className="pointer-events-none fixed inset-x-0 top-0 px-4 pt-3.5 sm:px-7 sm:pt-6 overflow-visible">
        <div className="mx-auto flex justify-center text-center overflow-visible">
          <div className="relative inline-block max-w-full overflow-visible">
            <h1 className="m-0">
              <img
                src="./assets/luis-title.png"
                alt="Luis's big movie dice"
                className="block h-auto w-[min(calc(100vw-32px),440px)] sm:h-[90px] sm:w-auto sm:max-w-[82vw] select-none"
                draggable={false}
              />
            </h1>
          </div>
        </div>
      </header>

      {/* Centered loading content */}
      <div className="flex h-full w-full items-center justify-center px-6 pt-20 sm:pt-24">
        <div className="w-full max-w-[380px] text-center">
          {errorMessage ? (
            <div className="rounded-xl border border-black/15 bg-white p-6 text-left shadow-sm">
              <p className="font-luis-hand text-[28px] leading-tight text-[#111215]">
                couldn&apos;t load watchlist
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[#5A5E69]">{errorMessage}</p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onRetry}
                  className="font-luis-hand h-11 rounded-lg bg-[#111215] px-5 text-[22px] text-white whitespace-nowrap transition-colors hover:bg-black cursor-pointer"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={onUsePreview}
                  className="font-luis-hand h-11 rounded-lg border border-black/20 bg-white px-5 text-[22px] text-[#111215] whitespace-nowrap transition-colors hover:border-black/40 cursor-pointer"
                >
                  Open preview
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="font-luis-hand text-[28px] sm:text-[32px] leading-[1.1] text-[#111215]">
                {headingLabel}
              </p>

              <HandDrawnProgressBar pct={pct} />

              <div className="mt-3 flex items-baseline justify-between gap-4">
                <span className="font-luis-hand truncate text-left text-[20px] sm:text-[22px] leading-[1.2] text-[#4E525D]">
                  {stepLabel}
                </span>
                <span className="font-luis-hand shrink-0 tabular-nums text-[20px] sm:text-[22px] leading-[1.2] text-[#111215]">
                  {rightStat}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
