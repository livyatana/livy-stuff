import { X } from 'lucide-react';
import type { UnmatchedEntry } from '../types/movie';

interface UnmatchedDrawerProps {
  unmatched: UnmatchedEntry[];
  onDismiss: () => void;
}

export function UnmatchedDrawer({ unmatched, onDismiss }: UnmatchedDrawerProps) {
  if (unmatched.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Unmatched titles"
      className="fixed bottom-20 right-4 sm:right-6 z-30 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-black/12 bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-black/10 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-[#111215]">
            Skipped Titles ({unmatched.length})
          </h3>
          <p className="text-xs text-[#6E727D]">No TMDB match or poster available</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss skipped titles"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6E727D] transition-colors hover:bg-black/5 hover:text-black"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="max-h-56 overflow-y-auto divide-y divide-black/5 px-4 py-1">
        {unmatched.map((item, idx) => (
          <li
            key={`${item.name}-${item.year}-${idx}`}
            className="flex items-center justify-between gap-3 py-2 text-xs"
          >
            <span className="truncate text-[#111215]">
              {item.name}{' '}
              {item.year && <span className="text-[#6E727D] tabular-nums">({item.year})</span>}
            </span>
            <span className="shrink-0 text-[#6E727D]">{item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
