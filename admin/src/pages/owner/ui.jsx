import { cx } from '../../lib/cx.js';

// The small pieces the owner console is drawn with. They follow the system look defined in index.css (`.sys`): a grouped grey page, white
// panels with modest corners, hairline separators, plain text labels, and buttons that are small to look at but have a 44px touch area.

const TOUCH = "relative before:absolute before:-inset-1 before:content-['']";

/** Page title with a line under it and the page's actions on the right. */
export function Title({ title, description, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.025em]">{title}</h1>
        {description && <p className="k-l2 mt-0.5 text-[0.9375rem]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A list header above a panel (small grey capitals, like a grouped list on iOS), with an optional link on the right. */
export function Section({ title, hint, action, className, children }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 className="k-l2 text-[0.75rem] font-semibold uppercase tracking-wide">
          {title}
          {hint && <span className="k-l3 ml-2 font-normal normal-case tracking-normal">{hint}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The white panel. Rows inside are separated by hairlines. */
export function Panel({ as: Tag = 'div', divided = false, className, children, ...rest }) {
  return (
    <Tag className={cx('k-card overflow-hidden rounded-xl', divided && 'k-divide', className)} {...rest}>
      {children}
    </Tag>
  );
}

/** A few figures in one panel, side by side, with hairlines between. */
export function Figures({ items }) {
  return (
    <dl className="k-grid-lines k-shadow grid grid-cols-2 gap-px overflow-hidden rounded-xl lg:grid-cols-4">
      {items.map((f) => (
        <div key={f.label} className="k-surface px-4 py-3.5">
          <dt className="k-l2 text-[0.8125rem] font-semibold">{f.label}</dt>
          <dd className={cx('mt-1 text-[1.5rem] font-bold leading-none tracking-[-0.03em] tabular-nums', f.tone)}>
            {f.value}
            {f.unit && <span className="k-l2 ml-1 text-[0.875rem] font-semibold tracking-normal">{f.unit}</span>}
          </dd>
          {f.note && <dd className="k-l3 mt-1.5 truncate text-[0.8125rem]">{f.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A short status in words, tinted (no pill: a small square corner). `tone`: gray | green | orange | red | blue. */
export function Label({ tone = 'gray', children, className }) {
  return <span className={cx('inline-flex items-center rounded-md px-1.5 py-px text-[0.75rem] font-semibold', `k-pill-${tone}`, className)}>{children}</span>;
}

export const buttonClass = {
  primary: `${TOUCH} k-fill-blue inline-flex h-9 items-center justify-center rounded-lg px-4 text-[0.875rem] font-semibold text-white transition active:opacity-80 disabled:opacity-50`,
  gray: `${TOUCH} k-fill k-l1 inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-[0.875rem] font-semibold transition active:opacity-70 disabled:opacity-50`,
  danger: `${TOUCH} k-red inline-flex h-9 items-center justify-center rounded-lg px-3 text-[0.875rem] font-semibold transition active:opacity-60 disabled:opacity-50`,
  link: `${TOUCH} k-blue inline-flex h-9 items-center justify-center px-1.5 text-[0.875rem] font-medium transition active:opacity-60 disabled:opacity-50`,
};

/** The sliding segmented control (a grey track and a white thumb). */
export function Segmented({ label, value, onChange, options, className }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="group" aria-label={label} className={cx('k-fill relative grid auto-cols-fr grid-flow-col rounded-lg p-0.5', className)}>
      <span
        aria-hidden="true"
        className="k-thumb absolute inset-y-0.5 left-0.5 rounded-md transition-transform duration-300"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${idx * 100}%)`, transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)' }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={cx('relative z-10 flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[0.8125rem] font-semibold transition-colors', o.value === value ? 'k-l1' : 'k-l2')}
        >
          {o.label}
          {o.count !== undefined && <span className="k-l3 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The restaurant's first letter on grey: the same for every restaurant, so nothing shouts. */
export function Avatar({ name, size = 'md', muted = false }) {
  return (
    <span
      aria-hidden="true"
      className={cx('k-fill grid shrink-0 place-items-center rounded-lg font-semibold', size === 'lg' ? 'size-12 text-[1.25rem]' : 'size-9 text-[0.9375rem]', muted ? 'k-l3' : 'k-l2')}
    >
      {String(name ?? '?').trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** A line in a list: title and a line of grey text on the left, something on the right. */
export function Row({ title, sub, right, className }) {
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3', className)}>
      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] font-medium">{title}</p>
        {sub && <p className="k-l2 mt-0.5 text-[0.8125rem]">{sub}</p>}
      </div>
      {right && <div className="shrink-0 text-right text-[0.875rem]">{right}</div>}
    </div>
  );
}
