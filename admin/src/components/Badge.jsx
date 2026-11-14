import { cx } from '../lib/cx.js';

const tones = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  orange: 'bg-brand-50 text-brand-800 ring-brand-200',
};
const dots = {
  slate: 'bg-slate-400',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  blue: 'bg-sky-500',
  red: 'bg-red-500',
  orange: 'bg-brand-500',
};

export function Badge({ tone = 'slate', dot = true, className = '', children }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>
      {dot && <span aria-hidden="true" className={cx('size-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  );
}

const STATUS = {
  pending: ['amber', 'Pending'],
  accepted: ['blue', 'Accepted'],
  completed: ['green', 'Completed'],
  cancelled: ['slate', 'Cancelled'],
};

/** `ready`: the kitchen has finished an accepted order (it waits for staff to complete it). */
export function StatusBadge({ status, ready = false }) {
  const [tone, label] = status === 'accepted' && ready ? ['green', 'Ready'] : STATUS[status] ?? ['slate', status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function PaymentBadge({ status, method, claimed = false }) {
  if (status === 'refunded') return <Badge tone="slate">Refunded</Badge>;
  if (status === 'paid') {
    const via = method === 'cash' ? ' · Cash' : method === 'razorpay' || method === 'cashfree' ? ' · Online' : method === 'upi' ? ' · UPI' : '';
    return <Badge tone="green">{`Paid${via}`}</Badge>;
  }
  // The diner says they paid by UPI; it only counts once staff confirm the money arrived.
  if (claimed) return <Badge tone="amber">Customer says paid</Badge>;
  return <Badge tone="red">Unpaid</Badge>;
}

const AVAILABILITY = {
  available: ['green', 'Available'],
  occupied: ['amber', 'Occupied'],
  maintenance: ['slate', 'Maintenance'],
};

export function AvailabilityBadge({ availability }) {
  const [tone, label] = AVAILABILITY[availability] ?? ['slate', availability];
  return <Badge tone={tone}>{label}</Badge>;
}

export function ActiveBadge({ active, on = 'Active', off = 'Inactive' }) {
  return <Badge tone={active ? 'green' : 'slate'}>{active ? on : off}</Badge>;
}
