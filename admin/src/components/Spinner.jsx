import { cx } from '../lib/cx.js';

export function Spinner({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0 animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A centred "loading" block for places that have no better skeleton. */
export function LoadingBlock({ label = 'Loading…', className = '' }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2 py-16 text-sm text-slate-500', className)}>
      <Spinner size={18} />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-slate-200/80', className)} />;
}
