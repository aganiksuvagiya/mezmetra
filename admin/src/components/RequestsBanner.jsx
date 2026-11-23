import { useState } from 'react';
import { Spinner } from './Spinner.jsx';
import { useToast } from './Toast.jsx';
import { BellIcon, CheckIcon, ReceiptIcon } from './icons.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { timeAgo } from '../lib/format.js';

const KIND = {
  waiter: { label: 'Waiter', icon: BellIcon },
  bill: { label: 'Bill', icon: ReceiptIcon },
};

/**
 * Diners waiting for the waiter or the bill, as one slim bar: a chip per request (oldest first) with the table, what they want and
 * how long they have waited. Tapping a chip marks it done. The bar keeps the same height however many are waiting (the chips
 * scroll sideways), so a busy floor never pushes the page down. Shown on every admin page until each request is done.
 */
export default function RequestsBanner() {
  const { requests, resolveRequest } = useLiveOrders();
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);

  if (requests.length === 0) return null;

  const done = async (id) => {
    setBusyId(id);
    try {
      await resolveRequest(id);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      aria-label="Customers waiting"
      className="mb-3 flex flex-col gap-2 rounded-2xl border border-black/[0.05] bg-white px-3 py-2.5 sm:mb-4 sm:flex-row sm:items-center sm:gap-3"
    >
      <h2 className="flex shrink-0 items-center gap-2 pl-1 text-sm font-semibold text-slate-900">
        <span aria-hidden="true" className="relative flex size-2.5">
          <span className="absolute inline-flex size-full rounded-full bg-amber-400 opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2.5 rounded-full bg-amber-500" />
        </span>
        Customers need you
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{requests.length}</span>
      </h2>

      <ul className="-mb-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {requests.map((r) => {
          const kind = KIND[r.kind] ?? KIND.waiter;
          const Icon = kind.icon;
          const busy = busyId === r.id;
          return (
            <li key={r.id} className="shrink-0">
              <button
                type="button"
                onClick={() => done(r.id)}
                disabled={busyId !== null}
                aria-label={`${kind.label} for table ${r.table_number}: mark done`}
                title="Tap when it is handled"
                className="group inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white pl-3 pr-1.5 text-sm transition-colors hover:bg-slate-50 disabled:opacity-60"
              >
                <Icon size={16} className="shrink-0 text-amber-600" />
                <span className="font-semibold text-slate-900">{r.table_number}</span>
                <span className="text-slate-500">
                  {kind.label} · {timeAgo(r.created_at)}
                </span>
                <span className="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-700 group-hover:bg-emerald-100">
                  {busy ? <Spinner /> : <CheckIcon size={16} />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
