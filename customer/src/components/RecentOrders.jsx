import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney } from '../lib/money';
import { clearRecentOrders } from '../lib/orderMemory';
import { formatTime } from '../lib/time';
import ConfirmSheet from './ConfirmSheet';

// How an order reads in the list: a short word and a colour, so a glance says "still cooking", "ready", "done" or "cancelled".
function statusOf(o) {
  if (o.status === 'cancelled') return { label: 'Cancelled', tone: 'bg-rose-100 text-rose-800' };
  if (o.status === 'completed') return o.paid ? { label: 'Completed', tone: 'bg-emerald-100 text-emerald-800' } : { label: 'Payment due', tone: 'bg-amber-100 text-amber-900' };
  if (o.status === 'accepted') return o.ready ? { label: 'Ready', tone: 'bg-emerald-100 text-emerald-800' } : { label: 'Preparing', tone: 'bg-brand-600/10 text-brand-800' };
  return { label: 'Received', tone: 'bg-amber-100 text-amber-900' };
}

/**
 * "Your recent orders": the orders this phone placed at this restaurant during this visit, so a diner who scans again can find them
 * (and how they are going) without having kept the page open. A card opens that order's own page. Finished orders leave the list on
 * their own after a while; "Clear" lets a diner (or the next person on a shared phone) empty it at once, after a question.
 */
export default function RecentOrders({ orders, tableToken, vendorName }) {
  const [clearing, setClearing] = useState(false);
  if (!orders || orders.length === 0) return null;
  return (
    <section aria-labelledby="recent-orders" className="pt-4">
      <div className="flex items-baseline justify-between gap-3 px-5">
        <h2 id="recent-orders" className="text-[15px] font-extrabold text-ink">
          Your recent orders
        </h2>
        <p className="flex items-center gap-1 text-xs text-ink-soft">
          Saved on this phone
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setClearing(true)}
            aria-label="Clear recent orders from this phone"
            className="-my-3 rounded-md px-1.5 py-3 text-xs font-semibold text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            Clear
          </button>
        </p>
      </div>
      <ul className="mt-2 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {orders.map((o) => {
          const { label, tone } = statusOf(o);
          return (
            <li key={o.token} className="w-[78%] max-w-72 shrink-0 snap-start">
              <Link
                to={`/o/${o.token}`}
                state={{ tableToken: tableToken || o.tableToken }}
                className="surface flex h-full flex-col gap-1.5 p-3.5 transition-colors hover:bg-brand-50 active:bg-brand-100"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-extrabold text-ink">{o.number ? `Order #${o.number}` : 'Order'}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${tone}`}>{label}</span>
                </span>
                <span className="line-clamp-1 text-sm text-ink-soft">{o.summary || 'Your order'}</span>
                <span className="mt-auto flex items-center justify-between gap-2 pt-1 text-xs text-ink-soft">
                  <span>{formatTime(new Date(o.placedAt).toISOString())}</span>
                  <span className="text-[15px] font-bold text-ink">{formatMoney(o.total)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {clearing && (
        <ConfirmSheet
          title="Clear these orders from this phone?"
          message="Only this phone forgets them. The restaurant still has every order. If one is still being made, you will not see it here any more."
          confirmLabel="Yes, clear them"
          cancelLabel="Keep them"
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            clearRecentOrders(vendorName);
            setClearing(false);
          }}
        />
      )}
    </section>
  );
}
