import { useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert, ErrorState } from '../../components/EmptyState.jsx';
import Modal from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Spinner.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../lib/api.js';
import { useAction, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';

const STATUS = { pending: 'Pending', accepted: 'Preparing', completed: 'Served' };

/**
 * A table's running bill: everything it ordered that is not paid yet, added up, with one button to take the payment for all of
 * it together (cash, or UPI the staff have seen arrive). Orders that come in afterwards get a bill of their own.
 */
export default function TableBillModal({ table, onClose, onChanged }) {
  const fmt = useFmt();
  const toast = useToast();
  const { vendor } = useAuth();
  const q = useQuery(() => api(`/api/admin/tables/${table.id}/bill`), [table.id], { interval: 8000 });
  const [run, busy] = useAction();
  const [confirm, setConfirm] = useState(null); // 'cash' | 'upi' | null
  const [error, setError] = useState(null);

  const methods = vendor?.payment_methods ?? ['cash', 'upi'];
  const bill = q.data;

  const settle = (method) =>
    run(async () => {
      setError(null);
      try {
        const done = await api(`/api/admin/tables/${table.id}/settle`, { method: 'POST', body: { method } });
        toast.success(`${done.settled} ${done.settled === 1 ? 'order' : 'orders'} paid (${fmt.money(done.total)}) for table ${table.number}.`);
        onChanged?.();
        onClose();
      } catch (e) {
        setError(e.message);
        setConfirm(null);
        q.reload();
      }
    });

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
      {bill && bill.count > 0 && !confirm && (
        <>
          {methods.includes('upi') && (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirm('upi')}>
              Paid by UPI
            </Button>
          )}
          {methods.includes('cash') && (
            <Button disabled={busy} onClick={() => setConfirm('cash')}>
              Paid by cash
            </Button>
          )}
        </>
      )}
      {bill && bill.count > 0 && confirm && (
        <>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>
            Back
          </Button>
          <Button busy={busy} onClick={() => settle(confirm)}>
            Yes, {fmt.money(bill.total)} received by {confirm === 'upi' ? 'UPI' : 'cash'}
          </Button>
        </>
      )}
    </>
  );

  return (
    <Modal title={`Bill · Table ${table.number}`} description="Everything this table has ordered that is not paid yet." size="md" onClose={onClose} footer={footer}>
      {q.loading && <Skeleton className="h-32 rounded-xl" />}
      {!q.loading && !bill && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load the bill" />}
      {bill && (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {bill.count === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">Nothing to pay: this table has no unpaid orders.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {bill.orders.map((o) => (
                  <li key={o.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">
                        Order #{o.id} <span className="font-normal text-slate-500">· {STATUS[o.status] ?? o.status}</span>
                      </p>
                      <p className="mt-0.5 break-words text-xs text-slate-500">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{fmt.money(o.total)}</p>
                  </li>
                ))}
              </ul>
              <p className="flex items-baseline justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-base font-bold text-slate-900">
                <span>Total to collect</span>
                <span className="tabular-nums">{fmt.money(bill.total)}</span>
              </p>
              {confirm && (
                <Alert tone="warning">
                  Only press <strong>Yes</strong> once the {fmt.money(bill.total)} has really arrived. All {bill.count} {bill.count === 1 ? 'order' : 'orders'} will be marked paid.
                </Alert>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
