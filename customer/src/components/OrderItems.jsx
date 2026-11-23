import { formatMoney } from '../lib/money';
import DishImage from './DishImage';

/** The dishes of a placed order, exactly as the server recorded them (names, options, instructions, line totals). */
export default function OrderItems({ items }) {
  const fixed = items.some((i) => Math.round(i.line_total * 100) % 100 !== 0);
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <DishImage item={item} className="size-12 shrink-0 rounded-xl" iconClass="size-6" />
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-snug text-ink">
              <span className="text-link tabular-nums">
                {item.quantity}
                <span className="sr-only"> ×</span>
                <span aria-hidden="true">×</span>
              </span>{' '}
              {item.name}
            </p>
            {item.options.length > 0 && <p className="text-sm text-ink-soft">{item.options.map((o) => o.name).join(', ')}</p>}
            {item.instructions && <p className="mt-0.5 break-words text-sm italic text-ink-soft">“{item.instructions}”</p>}
          </div>
          <p className="shrink-0 font-bold tabular-nums text-ink">{formatMoney(item.line_total, { fixed })}</p>
        </li>
      ))}
    </ul>
  );
}
