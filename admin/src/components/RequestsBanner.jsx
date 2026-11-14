import { useMemo, useState } from 'react';
import { Button } from './Button.jsx';
import { useToast } from './Toast.jsx';
import { BellIcon, CheckIcon, ReceiptIcon } from './icons.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';

/** How many tables are listed before the rest fold behind "Show N more", so a busy floor never pushes the page down. */
const VISIBLE_TABLES = 3;

const KIND = {
  waiter: { label: 'Waiter', icon: BellIcon },
  bill: { label: 'Bill', icon: ReceiptIcon },
};

/** Diners waiting for the waiter or the bill, one row per table. Shown on every admin page until staff tap each request done. */
export default function RequestsBanner() {
  const { requests, resolveRequest } = useLiveOrders();
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(false);

  // Requests arrive oldest first; keep that order, but put a table's waiter call and bill request on one row.
  const tables = useMemo(() => {
    const byTable = new Map();
    for (const r of requests) {
      if (!byTable.has(r.table_number)) byTable.set(r.table_number, { number: r.table_number, items: [] });
      byTable.get(r.table_number).items.push(r);
    }
    return [...byTable.values()];
  }, [requests]);

  if (tables.length === 0) return null;

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

  const hidden = Math.max(0, tables.length - VISIBLE_TABLES);
  const shown = expanded ? tables : tables.slice(0, VISIBLE_TABLES);

  return (
    <section aria-label="Customers waiting" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 sm:p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-amber-900">
          Customers need you <span className="font-semibold text-amber-800">({requests.length})</span>
        </h2>
        <p className="hidden text-xs text-amber-800 sm:block">Tap a request once it is handled</p>
      </div>
      <ul className="mt-2 space-y-2">
        {shown.map((t) => (
          <li key={t.number} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-white px-3 py-2 shadow-xs">
            <p className="min-w-0 break-words text-sm font-semibold text-slate-800">Table {t.number}</p>
            <div className="flex flex-wrap gap-2">
              {t.items.map((r) => {
                const kind = KIND[r.kind] ?? KIND.waiter;
                return (
                  <Button
                    key={r.id}
                    size="sm"
                    variant="secondary"
                    icon={kind.icon}
                    busy={busyId === r.id}
                    disabled={busyId !== null}
                    onClick={() => done(r.id)}
                    aria-label={`${kind.label} for table ${t.number}: mark done`}
                    className="!h-8 !gap-1.5 !px-2.5"
                  >
                    {kind.label}
                    <CheckIcon size={14} className="text-emerald-600" />
                  </Button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 inline-flex h-8 items-center rounded-lg px-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
        >
          {expanded ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'table' : 'tables'}`}
        </button>
      )}
    </section>
  );
}
