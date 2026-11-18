import { cx } from '../../lib/cx.js';
import { CheckIcon, CloseIcon } from '../../components/icons.jsx';

const METHOD = { cash: 'Cash at counter', razorpay: 'Online (Razorpay)', cashfree: 'Online (Cashfree)', phonepe: 'Online (PhonePe)', paytm: 'Online (Paytm)', upi: 'UPI' };

// The steps an order moves through one after another. "Paid" is separate: it can happen at any point (cash up front, online at the table).
const FLOW = ['Placed', 'Accepted', 'Ready', 'Completed'];

/**
 * Placed -> Accepted -> Ready -> Paid -> Completed, each with its time in the vendor's time zone. A step that has not happened yet
 * says "Waiting". A step staff never pressed but that the order is already past (an order completed without being marked "Ready")
 * says "Skipped" instead, so a finished order never claims to be waiting for something.
 */
export default function OrderTimeline({ order, fmt }) {
  const cancelled = order.status === 'cancelled';
  const flowTimes = { Placed: order.created_at, Accepted: order.accepted_at, Ready: order.ready_at, Completed: order.completed_at };
  const furthest = FLOW.reduce((n, label, i) => (flowTimes[label] ? i : n), -1); // the latest step of the flow that has happened
  const steps = [
    { label: 'Placed', at: order.created_at },
    { label: 'Accepted', at: order.accepted_at },
    { label: 'Ready', at: order.ready_at },
    { label: 'Paid', at: order.paid_at, detail: order.paid_at ? METHOD[order.payment_method] : null },
    { label: 'Completed', at: order.completed_at },
  ];

  return (
    <ol className="space-y-0">
      {steps.map((step, i) => {
        const done = Boolean(step.at);
        const skipped = !done && !cancelled && FLOW.indexOf(step.label) !== -1 && FLOW.indexOf(step.label) < furthest;
        const last = i === steps.length - 1 && !cancelled;
        return (
          <li key={step.label} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && <span aria-hidden="true" className={cx('absolute left-[11px] top-6 h-[calc(100%-1.5rem)] w-0.5', done ? 'bg-brand-300' : 'bg-slate-200')} />}
            <span
              aria-hidden="true"
              className={cx(
                'relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2',
                done ? 'border-brand-600 bg-brand-600 text-white' : skipped ? 'border-slate-300 bg-slate-200' : 'border-slate-300 bg-white',
              )}
            >
              {done && <CheckIcon size={13} />}
              {skipped && <span className="h-0.5 w-2 rounded-full bg-slate-400" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx('text-sm font-medium', done ? 'text-slate-900' : skipped ? 'text-slate-500' : 'text-slate-400')}>
                {step.label}
                {done ? <span className="sr-only">:</span> : skipped ? <span className="sr-only"> (skipped)</span> : <span className="sr-only"> (not yet)</span>}
              </p>
              <p className={cx('text-xs', done ? 'text-slate-500' : 'text-slate-400')}>
                {done ? fmt.dateTime(step.at) : cancelled ? '—' : skipped ? 'Skipped' : 'Waiting'}
                {step.detail && ` · ${step.detail}`}
              </p>
            </div>
          </li>
        );
      })}
      {cancelled && (
        <li className="relative flex gap-3">
          <span aria-hidden="true" className="relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-red-500 bg-red-500 text-white">
            <CloseIcon size={13} />
          </span>
          <div>
            <p className="text-sm font-medium text-red-700">Cancelled</p>
            <p className="text-xs text-slate-500">This order was cancelled.</p>
          </div>
        </li>
      )}
    </ol>
  );
}
