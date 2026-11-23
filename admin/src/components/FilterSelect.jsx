import { cx } from '../lib/cx.js';
import { ChevronDownIcon } from './icons.jsx';

/** A dropdown filter that matches SearchBox (white, rounded, same height), for the row above a list. Forms keep using Select. */
export default function FilterSelect({ label, className, children, ...props }) {
  return (
    <div className={cx('relative w-full', className)}>
      <select
        {...props}
        aria-label={label}
        className="h-11 w-full appearance-none rounded-xl border border-black/[0.05] bg-white pl-3 pr-9 text-sm text-slate-900 outline-none transition-colors focus:border-brand-500"
      >
        {children}
      </select>
      <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
    </div>
  );
}
