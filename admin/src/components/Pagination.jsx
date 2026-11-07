import { cx } from '../lib/cx.js';
import { formatNumber } from '../lib/format.js';
import { ChevronLeftIcon, ChevronRightIcon } from './icons.jsx';

function pageWindow(page, pages) {
  const set = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  list.forEach((p, i) => {
    if (i > 0 && p - list[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

export default function Pagination({ page, perPage, total, onPageChange, className = '' }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);

  return (
    <div className={cx('flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600 sm:flex-row', className)}>
      <p>
        Showing <strong className="font-semibold text-slate-800">{formatNumber(from)}–{formatNumber(to)}</strong> of{' '}
        <strong className="font-semibold text-slate-800">{formatNumber(total)}</strong>
      </p>
      {pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeftIcon size={16} />
          </button>
          {pageWindow(page, pages).map((p, i) =>
            p === 'gap' ? (
              <span key={`gap-${i}`} aria-hidden="true" className="px-1 text-slate-400">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-label={`Page ${p}`}
                aria-current={p === page ? 'page' : undefined}
                className={cx(
                  'inline-flex size-9 items-center justify-center rounded-lg border text-sm font-medium',
                  p === page ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
                )}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            aria-label="Next page"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronRightIcon size={16} />
          </button>
        </nav>
      )}
    </div>
  );
}
