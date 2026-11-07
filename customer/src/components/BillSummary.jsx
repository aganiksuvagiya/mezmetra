import { formatMoney, needsDecimals } from '../lib/money';

/** Subtotal / tax / total. All amounts in rupees; the order page passes the server's numbers straight through. */
export default function BillSummary({ subtotal, tax, total, taxLabel = 'Tax', totalLabel = 'Total', footnote }) {
  const fixed = needsDecimals(subtotal, tax, total);
  const fmt = (v) => formatMoney(v, { fixed });
  return (
    <div>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-soft">Subtotal</dt>
          <dd className="font-semibold tabular-nums text-ink">{fmt(subtotal)}</dd>
        </div>
        {tax > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-soft">{taxLabel}</dt>
            <dd className="font-semibold tabular-nums text-ink">{fmt(tax)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3 border-t border-dashed border-line pt-3 text-base">
          <dt className="font-extrabold text-ink">{totalLabel}</dt>
          <dd className="font-extrabold tabular-nums text-ink">{fmt(total)}</dd>
        </div>
      </dl>
      {footnote && <p className="mt-2 text-xs leading-snug text-ink-soft">{footnote}</p>}
    </div>
  );
}
