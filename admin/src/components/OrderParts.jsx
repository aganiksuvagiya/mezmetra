import { useState } from 'react';
import { apiUrl } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { OrdersIcon } from './icons.jsx';

// What the restaurant calls each stage of an order. An accepted order is "Preparing" until the kitchen marks it ready.
const PILL = {
  pending: ['bg-orange-50 text-orange-700', 'Pending'],
  preparing: ['bg-sky-50 text-sky-700', 'Preparing'],
  ready: ['bg-emerald-50 text-emerald-700', 'Ready'],
  completed: ['bg-slate-100 text-slate-700', 'Completed'],
  cancelled: ['bg-red-50 text-red-700', 'Cancelled'],
};

export const stageOf = (order) => (order.status === 'accepted' ? (order.ready_at ? 'ready' : 'preparing') : order.status);

/** The coloured stage label of an order (Pending, Preparing, Ready, Completed, Cancelled). */
export function StagePill({ order, className }) {
  const [tone, label] = PILL[stageOf(order)] ?? ['bg-slate-100 text-slate-700', order.status];
  return <span className={cx('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold', tone, className)}>{label}</span>;
}

/** A dish photo in a rounded square, or a quiet placeholder when there is none (or it fails to load). */
export function DishThumb({ url, icon: Icon = OrdersIcon, iconSize = 30, className }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cx('grid shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 text-slate-300', className)}>
      {url && !failed ? <img src={apiUrl(url)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" /> : <Icon size={iconSize} />}
    </span>
  );
}

/** The photo of the first dish in an order that has one. */
export function OrderThumb({ order, className, iconSize }) {
  return <DishThumb url={order.items.find((i) => i.photo_url)?.photo_url} className={className} iconSize={iconSize} />;
}
