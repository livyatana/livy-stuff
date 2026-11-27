import { Download, Share, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    if (!showIOSGuide) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowIOSGuide(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showIOSGuide]);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        aria-label="Install Movie Dice app"
        title="Install app"
        className="flex h-10 items-center gap-1.5 rounded-lg border border-black/12 bg-white/90 px-3 text-xs font-medium text-[#111215] shadow-xs transition-colors hover:border-black/30 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black cursor-pointer"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Install</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          aria-label="Install on iPhone or iPad"
          title="Add to Home Screen"
          className="flex h-10 items-center gap-1.5 rounded-lg border border-black/12 bg-white/90 px-2.5 sm:px-3 text-xs font-medium text-[#111215] shadow-xs transition-colors hover:border-black/30 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black cursor-pointer"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Install</span>
        </button>

        {showIOSGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Install Movie Dice on iOS"
            onClick={() => setShowIOSGuide(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xs rounded-2xl border border-black/10 bg-white p-5 text-left shadow-xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <img
                    src="./icons/pwa-192x192.png"
                    alt="Movie Dice icon"
                    className="h-10 w-10 rounded-xl border border-black/10"
                  />
                  <div>
                    <h3 className="text-sm font-semibold text-[#111215]">Install Movie Dice</h3>
                    <p className="text-[11px] text-[#6E727D]">Works offline on your home screen</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install instructions"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#6E727D] hover:bg-black/5 hover:text-black cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <ol className="mt-4 space-y-2 text-xs leading-relaxed text-[#383B45]">
                <li className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/6 text-[11px] font-semibold text-[#111215]">
                    1
                  </span>
                  <span>
                    Tap the <Share className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom text-[#111215]" />{' '}
                    <strong className="font-semibold text-[#111215]">Share</strong> button in Safari.
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/6 text-[11px] font-semibold text-[#111215]">
                    2
                  </span>
                  <span>
                    Scroll down and tap <strong className="font-semibold text-[#111215]">Add to Home Screen</strong>.
                  </span>
                </li>
              </ol>

              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-lg bg-[#111215] py-2 text-xs font-medium text-white transition-colors hover:bg-black cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
