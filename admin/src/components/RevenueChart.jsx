import { cx } from '../lib/cx.js';
import { formatDayLong, formatDayShort, formatMoney, formatMoneyCompact } from '../lib/format.js';

/**
 * Seven-day revenue bar chart in plain HTML/CSS. Each bar has a visible compact amount, a title (hover) and an
 * aria-label (screen readers / keyboard focus) with the exact figure. The last entry is "today".
 */
export default function RevenueChart({ days }) {
  const max = Math.max(0, ...days.map((d) => Number(d.revenue) || 0));

  return (
    <figure>
      <ul className="grid grid-cols-7 gap-1.5 sm:gap-4" aria-label="Revenue for each of the last 7 days">
        {days.map((d, i) => {
          const value = Number(d.revenue) || 0;
          const isToday = i === days.length - 1;
          const text = `${formatDayLong(d.day)}: ${formatMoney(value)}`;
          return (
            <li key={d.day} className="flex min-w-0 flex-col items-center">
              <div className="flex h-48 w-full flex-col items-center justify-end" title={text}>
                <span className="mb-1 max-w-full truncate text-[11px] font-medium tabular-nums text-slate-600 sm:text-xs">
                  {value > 0 ? formatMoneyCompact(value) : ''}
                </span>
                <div
                  role="img"
                  tabIndex={0}
                  aria-label={text}
                  className={cx(
                    'w-full max-w-14 rounded-t-md transition-[height]',
                    value > 0 ? (isToday ? 'bg-brand-500' : 'bg-brand-300') : 'bg-slate-200',
                  )}
                  style={{ height: value > 0 ? `${Math.max(2, (value / max) * 82)}%` : '4px' }}
                />
              </div>
              <span className={cx('mt-2 text-center text-[11px] leading-tight sm:text-xs', isToday ? 'font-semibold text-slate-900' : 'text-slate-500')}>{formatDayShort(d.day)}</span>
            </li>
          );
        })}
      </ul>
      <figcaption className="sr-only">Bar chart of paid-order revenue per day for the last seven days.</figcaption>
    </figure>
  );
}
