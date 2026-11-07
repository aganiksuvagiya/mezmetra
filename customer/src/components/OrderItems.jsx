import { formatMoney } from '../lib/money';

/** The dishes of a placed order, exactly as the server recorded them (names, options, instructions, line totals). */
export default function OrderItems({ items }) {
  const fixed = items.some((i) => Math.round(i.line_total * 100) % 100 !== 0);
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
          <span className="mt-0.5 grid h-6 min-w-6 place-items-center rounded-md bg-brand-100 px-1 text-xs font-extrabold tabular-nums text-brand-800">
            {item.quantity}
            <span className="sr-only"> ×</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-snug text-ink">{item.name}</p>
            {item.options.length > 0 && <p className="text-sm text-ink-soft">{item.options.map((o) => o.name).join(', ')}</p>}
            {item.instructions && <p className="mt-0.5 break-words text-sm italic text-ink-soft">“{item.instructions}”</p>}
          </div>
          <p className="shrink-0 font-bold tabular-nums text-ink">{formatMoney(item.line_total, { fixed })}</p>
        </li>
      ))}
    </ul>
  );
}
