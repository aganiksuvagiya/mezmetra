import { useId } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney } from '../lib/money';
import { formatTime } from '../lib/time';
import BottomSheet from './BottomSheet';
import { statusOf } from './RecentOrders';

/**
 * "Your orders" from the bottom bar: what this phone has ordered during this visit and how each is going. A row opens that order's own
 * page. (The same list as "Your recent orders" on the menu, in a sheet that is one tap away from anywhere on the menu.)
 */
export default function OrdersSheet({ orders, tableToken, onClose }) {
  const titleId = useId();
  return (
    <BottomSheet onClose={onClose} labelledBy={titleId}>
      <div className="px-5 pb-6 pt-6">
        <h2 id={titleId} className="display pr-12 text-[24px] font-extrabold leading-tight text-ink">
          Your orders
        </h2>
        <p className="mt-1 text-[15px] text-ink-soft">Placed from this phone during this visit.</p>

        {!orders || orders.length === 0 ? (
          <p className="mt-6 rounded-2xl bg-fill px-4 py-6 text-center text-[15px] text-ink-soft">
            No orders yet. Add something from the menu and it will show up here.
          </p>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {orders.map((o) => {
              const { label, tone } = statusOf(o);
              return (
                <li key={o.token}>
                  <Link
                    to={`/o/${o.token}`}
                    state={{ tableToken: tableToken || o.tableToken }}
                    className="surface flex flex-col gap-1.5 p-3.5 transition-colors hover:bg-tint active:bg-tint-strong"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-extrabold text-ink">{o.number ? `Order #${o.number}` : 'Order'}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${tone}`}>{label}</span>
                    </span>
                    <span className="line-clamp-1 text-sm text-ink-soft">{o.summary || 'Your order'}</span>
                    <span className="flex items-center justify-between gap-2 text-xs text-ink-soft">
                      <span>{formatTime(new Date(o.placedAt).toISOString())}</span>
                      <span className="text-[15px] font-bold text-ink">{formatMoney(o.total)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}
