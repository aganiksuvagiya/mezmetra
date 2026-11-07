import { useState } from 'react';
import { PaymentBadge, StatusBadge } from '../../components/Badge.jsx';
import { Button } from '../../components/Button.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { Alert, ErrorState } from '../../components/EmptyState.jsx';
import { InfoIcon, ReceiptIcon, TrashIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Spinner.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { api, apiBlob } from '../../lib/api.js';
import { downloadUrl, useAction, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import OrderTimeline from './OrderTimeline.jsx';

const PAY_PREF = { counter: 'at the counter', online: 'online', upi: 'with a UPI app' };

function Section({ title, children }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function OrderBody({ order, fmt }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={order.status} />
        <PaymentBadge status={order.payment_status} method={order.payment_method} claimed={Boolean(order.payment_claim)} />
        <span className="text-sm text-slate-600">
          Table <strong className="font-semibold text-slate-900">{order.table_number}</strong>
        </span>
        <span className="text-sm text-slate-500">· Placed {fmt.dateTime(order.created_at)}</span>
      </div>
      {order.payment_status === 'unpaid' && order.payment_claim && order.status !== 'cancelled' && (
        <Alert tone="warning">
          <strong>Customer says they paid {fmt.money(order.total)} by UPI</strong> ({fmt.dateTime(order.payment_claim.claimed_at)}
          {order.payment_claim.reference ? <>, reference <span className="font-mono">{order.payment_claim.reference}</span></> : ', no reference given'}).
          Check your bank or UPI app, then press <strong>Confirm UPI payment</strong>. Nothing counts as revenue until you do.
        </Alert>
      )}
      {order.payment_status === 'unpaid' && order.pay_pref && (order.status === 'pending' || order.status === 'accepted') && (
        <p className="-mt-3 text-sm text-slate-500">The customer plans to pay {PAY_PREF[order.pay_pref] ?? order.pay_pref}.</p>
      )}

      <Section title={`Items (${order.total_quantity})`}>
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">
                  {item.quantity}× {item.name}
                </p>
                {item.options.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 text-xs text-slate-500">
                    {item.options.map((o, i) => (
                      <li key={`${o.group}-${o.name}-${i}`}>
                        {o.group}: {o.name}
                        {Number(o.price) > 0 && ` (+${fmt.money(o.price)})`}
                      </li>
                    ))}
                  </ul>
                )}
                {item.instructions && <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">&ldquo;{item.instructions}&rdquo;</p>}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-medium text-slate-900 tabular-nums">{fmt.money(item.line_total)}</p>
                {item.quantity > 1 && <p className="text-xs text-slate-500 tabular-nums">{fmt.money(item.unit_price)} each</p>}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {order.note && (
        <Section title="Note from the table">
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{order.note}</p>
        </Section>
      )}

      <Section title="Bill">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-600">Subtotal</dt>
            <dd className="tabular-nums text-slate-900">{fmt.money(order.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">Tax</dt>
            <dd className="tabular-nums text-slate-900">{fmt.money(order.tax)}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
            <dt className="text-slate-900">Total</dt>
            <dd className="tabular-nums text-slate-900">{fmt.money(order.total)}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Timeline">
        <OrderTimeline order={order} fmt={fmt} />
      </Section>
    </div>
  );
}

/**
 * Order detail with the actions the business rules allow:
 *  pending  -> Accept (and Cancel / Record cash while unpaid)
 *  accepted -> Complete only when paid; when unpaid it says "Record payment first" instead of a dead button
 *  paid     -> cannot be cancelled, receipt available
 * Every action disables the buttons while it runs and shows the server's message if it is refused.
 */
export default function OrderDetailModal({ orderId, onClose, onChanged }) {
  const fmt = useFmt();
  const toast = useToast();
  const q = useQuery(() => api(`/api/admin/orders/${orderId}`), [orderId], { interval: 8000 });
  const [run, busy] = useAction();
  const [pending, setPending] = useState(null); // which action is running: 'accept' | 'complete' | 'receipt'
  const [actionError, setActionError] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'cancel' | 'cash' | 'delete' | null

  const { vendor } = useAuth();
  // Cash is only a payment method while the product offers it; with UPI only, staff confirm the UPI payment instead
  // (whether or not the diner tapped "I've paid").
  const cashOffered = vendor?.payment_methods?.includes('cash') ?? true;

  const order = q.data;
  const paid = order?.payment_status === 'paid';
  const active = order && (order.status === 'pending' || order.status === 'accepted');

  const applyUpdate = (updated, message) => {
    q.setData(updated);
    onChanged();
    toast.success(message);
  };

  const setStatus = (status, message) =>
    run(async () => {
      setActionError(null);
      setPending(status === 'accepted' ? 'accept' : 'complete');
      try {
        applyUpdate(await api(`/api/admin/orders/${orderId}/status`, { method: 'PATCH', body: { status } }), message);
      } catch (error) {
        setActionError(error.message);
        q.reload(); // the order may have changed under us (for example the customer just paid online)
      } finally {
        setPending(null);
      }
    });

  const openReceipt = () =>
    run(async () => {
      setActionError(null);
      setPending('receipt');
      // Open the tab synchronously (inside the click) so pop-up blockers allow it, then point it at the PDF.
      const tab = window.open('', '_blank');
      if (tab) {
        tab.opener = null;
        tab.document.title = `Receipt #${orderId}`;
        tab.document.body.textContent = 'Preparing receipt…';
      }
      try {
        const blob = await apiBlob(`/api/admin/orders/${orderId}/receipt.pdf`);
        const url = URL.createObjectURL(blob);
        if (tab) tab.location.href = url;
        else downloadUrl(url, `receipt-${orderId}.pdf`);
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
      } catch (error) {
        tab?.close();
        setActionError(error.message);
      } finally {
        setPending(null);
      }
    });

  let footer = null;
  if (order) {
    footer = (
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="danger-outline" icon={TrashIcon} disabled={busy} onClick={() => setConfirm('delete')}>
            Delete
          </Button>
          {order.receipt_url && (
            <Button variant="secondary" icon={ReceiptIcon} busy={pending === 'receipt'} disabled={busy} onClick={openReceipt}>
              View receipt
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {active && !paid && (
            <Button variant="danger-outline" disabled={busy} onClick={() => setConfirm('cancel')}>
              Cancel order
            </Button>
          )}
          {active && !paid && (order.payment_claim || !cashOffered) && (
            <Button variant={order.payment_claim || order.status === 'accepted' ? 'primary' : 'secondary'} disabled={busy} onClick={() => setConfirm('upi')}>
              Confirm UPI payment
            </Button>
          )}
          {active && !paid && cashOffered && (
            <Button variant={order.status === 'accepted' && !order.payment_claim ? 'primary' : 'secondary'} disabled={busy} onClick={() => setConfirm('cash')}>
              Record cash payment
            </Button>
          )}
          {order.status === 'pending' && (
            <Button busy={pending === 'accept'} disabled={busy} onClick={() => setStatus('accepted', `Order #${orderId} accepted.`)}>
              Accept order
            </Button>
          )}
          {order.status === 'accepted' && paid && (
            <Button busy={pending === 'complete'} disabled={busy} onClick={() => setStatus('completed', `Order #${orderId} completed.`)}>
              Complete order
            </Button>
          )}
          {order.status === 'accepted' && !paid && (
            <span className="inline-flex items-center gap-1.5 px-1 text-sm font-medium text-slate-600">
              <InfoIcon size={16} className="text-slate-400" />
              {cashOffered ? 'Record payment first' : 'Confirm payment first'}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <Modal title={`Order #${orderId}`} size="lg" onClose={onClose} footer={footer}>
        {q.loading && (
          <div role="status" aria-label="Loading order" className="space-y-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {!q.loading && !order && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load this order" className="py-8" />}
        {order && (
          <div className="space-y-4">
            {actionError && <Alert>{actionError}</Alert>}
            {q.error && <Alert tone="warning">Couldn&rsquo;t refresh this order ({q.error.message}). What you see may be out of date.</Alert>}
            <OrderBody order={order} fmt={fmt} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`Cancel order #${orderId}?`}
        message="The order will be marked cancelled and the table will see it as cancelled. This can’t be undone."
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const updated = await api(`/api/admin/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
          setConfirm(null);
          setActionError(null);
          applyUpdate(updated, `Order #${orderId} cancelled.`);
        }}
      />

      <ConfirmDialog
        open={confirm === 'cash'}
        tone="primary"
        title="Record cash payment?"
        message={order ? `Mark order #${orderId} as paid in cash (${fmt.money(order.total)}). This counts towards today’s revenue and can’t be undone.` : ''}
        confirmLabel="Record payment"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const updated = await api(`/api/admin/orders/${orderId}/cash-payment`, { method: 'POST' });
          setConfirm(null);
          setActionError(null);
          applyUpdate(updated, `Cash payment recorded for order #${orderId}.`);
        }}
      />

      <ConfirmDialog
        open={confirm === 'upi'}
        tone="primary"
        title="Confirm UPI payment?"
        message={
          order
            ? `Confirm that ${fmt.money(order.total)} for order #${orderId} arrived in your bank or UPI account${
                order.payment_claim?.reference ? ` (reference ${order.payment_claim.reference})` : ''
              }. This counts towards today’s revenue and can’t be undone.`
            : ''
        }
        confirmLabel="Confirm payment"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const updated = await api(`/api/admin/orders/${orderId}/upi-payment`, { method: 'POST', body: {} });
          setConfirm(null);
          setActionError(null);
          applyUpdate(updated, `UPI payment confirmed for order #${orderId}.`);
        }}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete order #${orderId}?`}
        message={
          <>
            <p>This permanently removes the order{paid ? ' and its payment' : ''}.</p>
            <p className="mt-2 font-medium text-red-700">
              It also removes it from your revenue history, so dashboard totals{paid ? ` (including ${fmt.money(order?.total)} of paid revenue)` : ''} will change. This can&rsquo;t be undone.
            </p>
          </>
        }
        confirmLabel="Delete order"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await api(`/api/admin/orders/${orderId}`, { method: 'DELETE' });
          setConfirm(null);
          toast.success(`Order #${orderId} deleted.`);
          onChanged();
          onClose();
        }}
      />
    </>
  );
}
