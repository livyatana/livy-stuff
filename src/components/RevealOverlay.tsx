import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { RevealScreenLayout } from '../three/MovieDieEngine';
import type { MovieDetails, MovieRecord } from '../types/movie';

interface RevealOverlayProps {
  movie: MovieRecord;
  details: MovieDetails | null;
  layout: RevealScreenLayout;
  isFadingOut: boolean;
  skipInitialPause?: boolean;
  actionLabel?: string;
  onRollAgain: () => void;
}

function formatRuntime(minutes: number | null | undefined): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function RevealOverlay({
  movie,
  details,
  layout,
  isFadingOut,
  skipInitialPause = false,
  actionLabel = 'Roll again',
  onRollAgain,
}: RevealOverlayProps) {
  const mountedAtRef = useRef<number>(performance.now());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardHeight, setCardHeight] = useState(320);

  useEffect(() => {
    mountedAtRef.current = performance.now();
  }, [movie.id]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setCardHeight(h);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [movie.id, details, layout]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onRollAgain();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onRollAgain]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

  const letterboxdUrl = useMemo(() => {
    if (movie.media_type === 'tv' || movie.id <= 0 || movie.isPreviewFallback) {
      const query = movie.year ? `${movie.title} ${movie.year}` : movie.title;
      return `https://letterboxd.com/search/${encodeURIComponent(query)}/`;
    }
    return `https://letterboxd.com/tmdb/${movie.id}/`;
  }, [movie.id, movie.isPreviewFallback, movie.media_type, movie.title, movie.year]);

  const infoParts = useMemo(() => {
    const parts: string[] = [];
    if (movie.year) parts.push(movie.year);
    if (details) {
      if (details.genre) parts.push(details.genre);
      const isTv = details.mediaType === 'tv' || movie.media_type === 'tv';
      if (isTv) {
        parts.push('series');
      } else {
        const rt = formatRuntime(details.runtime);
        if (rt) parts.push(rt);
      }
    }
    return parts;
  }, [details, movie.media_type, movie.year]);

  const dialogStyle = useMemo<CSSProperties>(() => {
    if (layout.isNarrow) {
      const idealTop = layout.bottomEdgeY + 18;
      const maxTop = Math.max(12, vh - cardHeight - 16);
      const topPx = Math.min(idealTop, maxTop);
      return {
        left: '50%',
        top: `${Math.round(topPx)}px`,
        transform: 'translateX(-50%)',
        width: 'min(92vw, 560px)',
      };
    }

    const desiredLeft = Math.max(vw * 0.45, layout.rightEdgeX + 28);
    const maxAllowedLeft = Math.max(16, vw - 300);
    const leftPx = Math.min(maxAllowedLeft, desiredLeft);
    const widthPx = Math.max(260, Math.min(560, vw - leftPx - 24));
    const halfH = cardHeight * 0.5;
    const minCenterY = Math.min(vh * 0.5, halfH + 16);
    const maxCenterY = Math.max(vh * 0.5, vh - halfH - 16);
    const centerYPx = Math.min(maxCenterY, Math.max(minCenterY, layout.centerY));

    return {
      left: `${Math.round(leftPx)}px`,
      top: `${Math.round(centerYPx)}px`,
      transform: 'translateY(-50%)',
      width: `${Math.round(widthPx)}px`,
    };
  }, [cardHeight, layout, vh, vw]);

  const dialogDelayMs = skipInitialPause ? '0ms' : '300ms';
  const buttonDelayMs = skipInitialPause ? '300ms' : '600ms';

  const handleBackdropClick = () => {
    // Prevent an impatient skip-reveal tap from immediately dismissing the dialog
    if (performance.now() - mountedAtRef.current < 380) return;
    onRollAgain();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={movie.title}
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-30 transition-opacity duration-400 ${
        isFadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
      }`}
    >
      <div
        key={movie.id}
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
        className="fixed"
      >
        <div
          ref={cardRef}
          style={{ '--dialog-delay': dialogDelayMs } as CSSProperties}
          className={`reveal-dialog-font animate-dialog-rise max-h-[calc(100vh-24px)] overflow-y-auto rounded-[14px] bg-[#FF2EB8] p-[22px] sm:p-[36px] shadow-[0_0_24px_rgba(255,46,184,0.6),0_0_60px_rgba(255,46,184,0.35)] flex flex-col gap-[14px] sm:gap-[18px] ${
            layout.isNarrow ? 'items-center text-center' : 'items-start text-left'
          }`}
        >
          <h2 className="text-[clamp(40px,13vw,52px)] sm:text-[76px] font-normal leading-[1.05] text-black break-words max-w-full">
            {movie.title}
          </h2>

          {infoParts.length > 0 && (
            <p className="text-[clamp(21px,6.5vw,26px)] sm:text-[36px] font-normal leading-[1.15] text-black/85">
              {infoParts.map((part, idx) => (
                <Fragment key={`${part}-${idx}`}>
                  {idx > 0 && (
                    <span className="mx-2 text-black/45" aria-hidden="true">
                      ·
                    </span>
                  )}
                  <span>{part}</span>
                </Fragment>
              ))}
            </p>
          )}

          <a
            href={letterboxdUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-block pb-[4px] text-[clamp(20px,6vw,24px)] sm:text-[32px] font-normal leading-[1.2] text-black underline decoration-[2px] underline-offset-[10px] hover:decoration-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:ring-offset-[#FF2EB8] rounded-xs"
          >
            view on letterboxd ↗
          </a>

          <button
            type="button"
            onClick={onRollAgain}
            style={{ '--button-delay': buttonDelayMs } as CSSProperties}
            className="animate-dialog-button mt-1 inline-flex items-center justify-center rounded-[10px] bg-black px-[24px] py-[13px] sm:px-[34px] sm:py-[18px] text-[clamp(22px,6.5vw,26px)] sm:text-[34px] font-normal leading-none text-[#FF2EB8] transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:ring-offset-[#FF2EB8] cursor-pointer"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
