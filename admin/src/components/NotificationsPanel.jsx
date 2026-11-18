import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { useReserveSidePanelSpace } from '../context/SidePanelContext.jsx';
import { cx } from '../lib/cx.js';
import { orderItemsSummary, timeAgo } from '../lib/format.js';
import { useMediaQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import { Button } from './Button.jsx';
import { BellIcon, CardIcon, CheckCircleIcon, CheckIcon, OrdersIcon, ReceiptIcon } from './icons.jsx';
import Modal from './Modal.jsx';
import SidePanel from './SidePanel.jsx';
import { useToast } from './Toast.jsx';

// How each kind of notification looks: its picture, its colours (picture tile, small label, left edge) and its one button.
const KINDS = {
  waiter: { icon: BellIcon, tile: 'bg-amber-100 text-amber-700', text: 'text-amber-700', edge: 'shadow-[inset_3px_0_0_var(--color-amber-400)]', action: 'Mark done' },
  bill: { icon: ReceiptIcon, tile: 'bg-amber-100 text-amber-700', text: 'text-amber-700', edge: 'shadow-[inset_3px_0_0_var(--color-amber-400)]', action: 'Mark done' },
  order: { icon: OrdersIcon, tile: 'bg-brand-50 text-brand-700', text: 'text-brand-700', edge: 'shadow-[inset_3px_0_0_var(--color-brand-500)]', action: 'View order' },
  claim: { icon: CardIcon, tile: 'bg-emerald-100 text-emerald-700', text: 'text-emerald-700', edge: 'shadow-[inset_3px_0_0_var(--color-emerald-500)]', action: 'View order' },
};

/**
 * The notification list that opens when the bell is pressed: everything waiting for staff right now (customers calling the waiter
 * or asking for the bill, orders waiting to be accepted, UPI payments to confirm), newest first. An entry disappears as soon as it
 * is dealt with. "Done" finishes a customer request; an order entry (or its "View" button) opens that order on the Orders page.
 * On a wide screen it is docked against the right edge like the order panel (the page shrinks to make room, nothing is dimmed);
 * on a phone it is a full-screen drawer.
 */
export default function NotificationsPanel({ onClose }) {
  const { notifications, resolveRequest } = useLiveOrders();
  const fmt = useFmt();
  const toast = useToast();
  const navigate = useNavigate();
  const [busyKey, setBusyKey] = useState(null);
  const docked = useMediaQuery('(min-width: 1024px)'); // the same width at which the sidebar and the docked order panel appear
  useReserveSidePanelSpace(docked);

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

  // Each card reads: a small coloured label (what it is), the table as the headline, then one line of detail.
  const describe = (n) => {
    switch (n.type) {
      case 'waiter':
        return { label: 'Waiter call', title: `Table ${n.table}`, detail: 'Is calling the waiter.' };
      case 'bill':
        return { label: 'Bill request', title: `Table ${n.table}`, detail: 'Would like the bill.' };
      case 'claim':
        return {
          label: `Payment to confirm · #${n.order.number}`,
          title: `Table ${n.order.table_number}`,
          detail: `Says they paid ${fmt.money(n.order.total)} by UPI.`,
        };
      default:
        return {
          label: `New order · #${n.order.number}`,
          title: `Table ${n.order.table_number}`,
          detail: `${orderItemsSummary(n.order.items, 2)} · ${fmt.money(n.order.total)}`,
        };
    }
  };

  const description = 'Orders to accept, customers waiting and payments to confirm.';
  const list = (
    <>
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
            const { label, title, detail } = describe(n);
            const Icon = kind.icon;
            const isRequest = n.type === 'waiter' || n.type === 'bill';
            return (
              <li
                key={n.key}
                className={cx(
                  'overflow-hidden rounded-xl border border-slate-200 bg-white p-3.5 transition-colors', // (no drop shadow: the coloured left edge is a box-shadow too)
                  kind.edge,
                  !isRequest && 'cursor-pointer hover:border-brand-200 hover:bg-brand-50/40',
                )}
                // An order or payment card opens that order wherever on it you press; its button keeps working on its own.
                onClick={isRequest ? undefined : () => view(n)}
              >
                <div className="flex items-start gap-3">
                  <span className={cx('grid size-10 shrink-0 place-items-center rounded-lg', kind.tile)}>
                    <Icon size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={cx('min-w-0 truncate text-[11px] font-bold uppercase tracking-wide', kind.text)}>{label}</p>
                      <p className="shrink-0 text-xs text-slate-400">{timeAgo(n.at, now)}</p>
                    </div>
                    <p className="mt-0.5 break-words text-base font-semibold leading-snug text-slate-900">{title}</p>
                    {detail && <p className="mt-0.5 break-words text-[13px] text-slate-600">{detail}</p>}
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant={isRequest ? 'secondary' : 'primary'}
                    icon={isRequest ? CheckIcon : undefined}
                    busy={busyKey === n.key}
                    disabled={busyKey !== null}
                    onClick={(e) => {
                      e.stopPropagation(); // the card itself opens the order too; do not open it twice
                      if (isRequest) done(n);
                      else view(n);
                    }}
                    aria-label={`${label}, ${title}: ${isRequest ? 'mark done' : 'view order'}`}
                  >
                    {kind.action}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  if (docked) {
    return createPortal(
      <div className="fixed inset-y-0 right-0 z-40 w-[22rem] xl:w-[26rem] print:hidden">
        <SidePanel title="Notifications" onClose={onClose}>
          <p className="mb-3 text-sm text-slate-500">{description}</p>
          {list}
        </SidePanel>
      </div>,
      document.body,
    );
  }
  return (
    <Modal variant="drawer" size="sm" title="Notifications" description={description} onClose={onClose}>
      {list}
    </Modal>
  );
}
