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
    <nav aria-label="Main" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
      <div className="glass pointer-events-auto mx-auto flex max-w-md items-center gap-2 rounded-[30px] p-2 shadow-dock motion-safe:animate-bar-in">
        <button
          type="button"
          onClick={toTop}
          className="flex h-14 w-[4.25rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[22px] bg-brand-50 text-[11px] font-bold text-brand-700 transition-colors hover:bg-brand-100"
        >
          <MenuBookIcon className="size-5" />
          Menu
        </button>

        {count > 0 ? (
          <Link
            to={`/t/${token}/cart`}
            className="flex h-14 min-w-0 flex-1 items-center justify-between gap-2 rounded-[22px] bg-brand-600 pl-2.5 pr-4 text-white transition-colors hover:bg-brand-700 active:bg-brand-800"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="relative grid size-10 shrink-0 place-items-center rounded-2xl bg-white/15">
                <BagIcon className="size-5" />
                <span
                  aria-hidden="true"
                  className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-saffron-300 px-1 text-[11px] font-extrabold leading-none text-ink ring-2 ring-brand-600"
                >
                  {count}
                </span>
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-[17px] font-extrabold tabular-nums">{formatPaise(subtotalPaise)}</span>
                <span className="text-xs font-semibold text-brand-100">{count === 1 ? '1 item' : `${count} items`}</span>
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[15px] font-extrabold">
              View cart
              <ChevronRightIcon className="size-5" />
            </span>
          </Link>
        ) : (
          <Link
            to={`/t/${token}/cart`}
            className="flex h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-[22px] bg-black/5 text-[15px] font-bold text-ink-soft transition-colors hover:bg-black/10"
          >
            <BagIcon className="size-5" />
            Your cart is empty
          </Link>
        )}
      </div>
    </nav>
  );
}
