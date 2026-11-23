import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import BottomSheet from './BottomSheet';
import { BagIcon, BellIcon, ChevronRightIcon, MenuIcon, ReceiptIcon, SearchIcon } from './Icons';
import OrdersSheet from './OrdersSheet';
import ServiceButtons from './ServiceButtons';
import { formatPaise } from '../lib/money';
import { useDesign } from '../lib/theme';
import { useRecentOrders } from '../lib/useRecentOrders';

// Height of the "View cart" button that floats above the tab bar while the cart has something in it (see --cta-h in index.css).
const CTA_HEIGHT = '4rem';

const tabClass = 'relative flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors active:bg-fill';

/**
 * The bottom bar of the menu, like an iPhone tab bar: Menu (back to top), Search (jumps to the search field), Cart (with a count),
 * Orders (what this phone has ordered, in a sheet) and Help (call the waiter / ask for the bill, in a sheet), so each is one tap away
 * however far down the menu you are. While the cart has something in it a "View cart · ₹199" button floats just above the bar.
 */
export function Dock({ token, vendorName, count, subtotalPaise }) {
  const design = useDesign();
  const [helpOpen, setHelpOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const helpTitle = useId();
  const orders = useRecentOrders(vendorName);
  const inProgress = orders.some((o) => !o.done); // an order that is still being made: a dot on the Orders tab
  const toTop = () => window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const goSearch = () => {
    toTop();
    document.getElementById('menu-search')?.focus({ preventScroll: true });
  };
  const itemsLabel = count === 1 ? '1 item' : `${count} items`;

  // Tell the page how much room the floating button (and a lifted bar) takes, so the last dish and the toasts stay clear of it.
  const floating = design.dock === 'float';
  useEffect(() => {
    const root = document.documentElement.style;
    if (count > 0) root.setProperty('--cta-h', CTA_HEIGHT);
    else root.removeProperty('--cta-h');
    if (floating) root.setProperty('--dock-extra', '0.75rem');
    else root.removeProperty('--dock-extra');
    return () => {
      root.removeProperty('--cta-h');
      root.removeProperty('--dock-extra');
    };
  }, [count > 0, floating]); // eslint-disable-line react-hooks/exhaustive-deps -- only whether the cart is empty matters

  return (
    <div className={`fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md ${floating ? 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]' : ''}`}>
      {count > 0 && (
        <div className="px-3 pb-2">
          <Link
            to={`/t/${token}/cart`}
            className="flex h-14 items-center justify-between gap-3 rounded-2xl bg-brand-600 pl-4 pr-3.5 text-white shadow-float transition-colors hover:bg-brand-700 active:bg-brand-800 motion-safe:animate-bar-in"
          >
            <span className="min-w-0 truncate text-[15px] font-semibold">
              View cart<span className="text-white/75"> · {itemsLabel}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[17px] font-bold tabular-nums">
              {formatPaise(subtotalPaise)}
              <ChevronRightIcon className="size-4 opacity-80" />
            </span>
          </Link>
        </div>
      )}

      <nav
        aria-label="Main"
        className={
          design.dock === 'flat'
            ? 'border-t border-line bg-card pb-[env(safe-area-inset-bottom)]'
            : floating
              ? 'glass mx-3 rounded-[1.75rem] shadow-float'
              : 'glass rounded-t-[1.25rem] pb-[env(safe-area-inset-bottom)]'
        }
      >
        <ul className="grid grid-cols-5">
          <li>
            <button type="button" onClick={toTop} aria-current="page" className={`${tabClass} text-link`}>
              <MenuIcon className="size-[24px]" />
              Menu
            </button>
          </li>
          <li>
            <button type="button" onClick={goSearch} className={`${tabClass} text-ink-soft`}>
              <SearchIcon className="size-[24px]" />
              Search
            </button>
          </li>
          <li>
            <Link to={`/t/${token}/cart`} className={`${tabClass} text-ink-soft`}>
              <span className="relative">
                <BagIcon className="size-[24px]" />
                {count > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-extrabold leading-none text-white"
                  >
                    {count}
                  </span>
                )}
              </span>
              Cart
              <span className="sr-only">{count > 0 ? `, ${itemsLabel}` : ', empty'}</span>
            </Link>
          </li>
          <li>
            <button type="button" onClick={() => setOrdersOpen(true)} aria-haspopup="dialog" className={`${tabClass} text-ink-soft`}>
              <span className="relative">
                <ReceiptIcon className="size-[24px]" />
                {inProgress && <span aria-hidden="true" className="absolute -right-1 -top-0.5 size-2.5 rounded-full bg-brand-600 ring-2 ring-white" />}
              </span>
              Orders
              {inProgress && <span className="sr-only">, one is in progress</span>}
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setHelpOpen(true)} aria-haspopup="dialog" className={`${tabClass} text-ink-soft`}>
              <BellIcon className="size-[24px]" />
              Help
            </button>
          </li>
        </ul>
      </nav>

      {ordersOpen && <OrdersSheet orders={orders} tableToken={token} onClose={() => setOrdersOpen(false)} />}

      {helpOpen && (
        <BottomSheet onClose={() => setHelpOpen(false)} labelledBy={helpTitle}>
          <div className="space-y-4 px-5 pb-6 pt-6">
            <div>
              <h2 id={helpTitle} className="display pr-12 text-[24px] font-extrabold leading-tight text-ink">
                Need something?
              </h2>
              <p className="mt-1 text-[15px] text-ink-soft">We will let the staff know right away.</p>
            </div>
            <ServiceButtons tableToken={token} grid />
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
