import { Link } from 'react-router-dom';
import { BagIcon, ChevronRightIcon, MenuBookIcon } from './Icons';
import { formatPaise } from '../lib/money';

/**
 * Floating glass dock at the bottom of the menu: "Menu" (back to top) and one big cart control that turns into a
 * "₹199 · View cart" call-to-action as soon as the cart has something in it. One bar instead of two stacked ones.
 */
export function Dock({ token, count, subtotalPaise }) {
  const toTop = () => window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

  return (
    <nav aria-label="Main" className="glass fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md rounded-t-[1.25rem] pb-[env(safe-area-inset-bottom)] motion-safe:animate-bar-in">
      <div className="flex items-center gap-3 px-3 pb-2 pt-2">
        <button
          type="button"
          onClick={toTop}
          className="flex h-12 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold text-brand-700 transition-colors hover:bg-black/5 active:bg-black/10"
        >
          <MenuBookIcon className="size-[22px]" />
          Menu
        </button>

        {count > 0 ? (
          <Link
            to={`/t/${token}/cart`}
            className="flex h-12 min-w-0 flex-1 items-center justify-between gap-2 rounded-[14px] bg-brand-600 pl-3 pr-3.5 text-white transition-colors hover:bg-brand-700 active:bg-brand-800"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-6 min-w-6 place-items-center rounded-full bg-white px-1.5 text-[13px] font-extrabold leading-none text-brand-700" aria-hidden="true">
                {count}
              </span>
              <span className="truncate text-[15px] font-semibold">
                View cart<span className="sr-only">, {count === 1 ? '1 item' : `${count} items`}</span>
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[17px] font-bold tabular-nums">
              {formatPaise(subtotalPaise)}
              <ChevronRightIcon className="size-4 opacity-80" />
            </span>
          </Link>
        ) : (
          <Link
            to={`/t/${token}/cart`}
            className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-[14px] bg-black/[0.06] text-[15px] font-semibold text-ink-soft transition-colors hover:bg-black/10"
          >
            <BagIcon className="size-5" />
            Your cart is empty
          </Link>
        )}
      </div>
    </nav>
  );
}
