import { cx } from '../lib/cx.js';

/** One figure above a list: a big number and what it counts. Put several in a grid; the tile shrinks on a phone. */
export default function StatTile({ label, value, note, className }) {
  return (
    <div className={cx('rounded-2xl border border-black/[0.05] bg-white px-3 py-3 @xl:px-4 @xl:py-3.5', className)}>
      <p className="text-2xl font-semibold leading-none tracking-tight text-slate-900 tabular-nums @xl:text-3xl">{value}</p>
      <p className="mt-1.5 truncate text-xs text-slate-500 @xl:mt-2 @xl:text-sm">{label}</p>
      {note && <p className="mt-0.5 truncate text-xs text-slate-400">{note}</p>}
    </div>
  );
}
