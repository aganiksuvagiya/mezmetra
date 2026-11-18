import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { cx } from '../lib/cx.js';
import { orderItemsSummary, timeAgo } from '../lib/format.js';
import { useFmt } from '../lib/useFmt.js';
import { Button } from './Button.jsx';
import { BellIcon, CardIcon, CheckCircleIcon, OrdersIcon, ReceiptIcon } from './icons.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';

// How each kind of notification looks: its picture, its colour, and what the one button on it says.
const KINDS = {
  waiter: { icon: BellIcon, tile: 'bg-amber-100 text-amber-700', action: 'Done' },
  bill: { icon: ReceiptIcon, tile: 'bg-amber-100 text-amber-700', action: 'Done' },
  order: { icon: OrdersIcon, tile: 'bg-brand-50 text-brand-700', action: 'View' },
  claim: { icon: CardIcon, tile: 'bg-emerald-100 text-emerald-700', action: 'View' },
};

/**
 * The notification list that slides in from the right edge when the bell is pressed: everything waiting for staff right now
 * (customers calling the waiter or asking for the bill, orders waiting to be accepted, UPI payments to confirm), newest first.
 * An entry disappears as soon as it is dealt with. "Done" finishes a customer request; "View" opens the order on the Orders page.
 */
export default function NotificationsPanel({ onClose }) {
  const { notifications, resolveRequest } = useLiveOrders();
  const fmt = useFmt();
  const toast = useToast();
  const navigate = useNavigate();
  const [busyKey, setBusyKey] = useState(null);

  // "3 min ago" goes stale while the panel stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const done = async (n) => {
    setBusyKey(n.key);
    try {
      await resolveRequest(n.requestId);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyKey(null);
    }
  };

  const view = (n) => {
    onClose();
    navigate(`/orders?order=${n.order.id}`);
  };

  const describe = (n) => {
    switch (n.type) {
      case 'waiter':
        return { title: `Table ${n.table} is calling the waiter`, detail: '' };
      case 'bill':
        return { title: `Table ${n.table} wants the bill`, detail: '' };
      case 'claim':
        return {
          title: `Confirm payment for order #${n.order.number}`,
          detail: `Table ${n.order.table_number} says they paid ${fmt.money(n.order.total)} by UPI`,
        };
      default:
        return {
          title: `New order #${n.order.number} · Table ${n.order.table_number}`,
          detail: `${orderItemsSummary(n.order.items, 2)} · ${fmt.money(n.order.total)}`,
        };
    }
  };

  return (
    <Modal variant="drawer" size="sm" title="Notifications" description="Orders to accept, customers waiting and payments to confirm." onClose={onClose}>
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-12 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-emerald-100 text-emerald-700">
            <CheckCircleIcon size={26} />
          </span>
          <p className="mt-3 font-semibold text-slate-900">You&apos;re all caught up</p>
          <p className="mt-1 max-w-64 text-sm text-slate-500">New orders and customer requests will show up here as they come in.</p>
        </div>
      ) : (
        <ul className="space-y-2.5" aria-label="What needs you now">
          {notifications.map((n) => {
            const kind = KINDS[n.type];
            const { title, detail } = describe(n);
            const Icon = kind.icon;
            const isRequest = n.type === 'waiter' || n.type === 'bill';
            return (
              <li key={n.key} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
                <span className={cx('grid size-10 shrink-0 place-items-center rounded-lg', kind.tile)}>
                  <Icon size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold text-slate-900">{title}</p>
                  {detail && <p className="mt-0.5 break-words text-[13px] text-slate-600">{detail}</p>}
                  <p className="mt-0.5 text-xs text-slate-400">{timeAgo(n.at, now)}</p>
                </div>
                <Button
                  size="sm"
                  variant={isRequest ? 'secondary' : 'primary'}
                  busy={busyKey === n.key}
                  disabled={busyKey !== null}
                  onClick={() => (isRequest ? done(n) : view(n))}
                  aria-label={isRequest ? `${title}: mark done` : `${title}: view order`}
                  className="shrink-0"
                >
                  {kind.action}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
