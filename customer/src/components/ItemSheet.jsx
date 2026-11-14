import { useId, useMemo, useState } from 'react';
import BottomSheet from './BottomSheet';
import DietMark from './DietMark';
import DishImage from './DishImage';
import QuantityStepper from './QuantityStepper';
import { Button } from './Button';
import { buildLine, MAX_INSTRUCTIONS } from '../lib/cart';
import { formatDelta, formatMoney, formatPaise, toPaise } from '../lib/money';

/**
 * Customise-and-add sheet for one dish: option groups (radio / checkbox, "Required" badge, price deltas),
 * cooking instructions, quantity. "Add to cart" stays disabled until every required group is chosen and says
 * which ones are missing. `onAdd(line)` returns true when the line was added (the sheet then closes).
 */
export default function ItemSheet({ item, onClose, onAdd }) {
  const titleId = useId();
  const hintId = useId();
  const groups = item.option_groups ?? [];

  const [selected, setSelected] = useState({}); // group id -> [option id]
  const [instructions, setInstructions] = useState('');
  const [quantity, setQuantity] = useState(1);

  const chosen = useMemo(
    () =>
      groups.flatMap((g) =>
        g.options.filter((o) => (selected[g.id] ?? []).includes(o.id)).map((o) => ({ ...o, group: g.name })),
      ),
    [groups, selected],
  );
  const missing = groups.filter((g) => g.required && !(selected[g.id]?.length > 0));
  const unitPaise = toPaise(item.price) + chosen.reduce((sum, o) => sum + toPaise(o.price), 0);
  const totalPaise = unitPaise * quantity;

  const choose = (group, option) =>
    setSelected((s) => {
      const current = s[group.id] ?? [];
      if (group.multi_select) {
        return { ...s, [group.id]: current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id] };
      }
      return { ...s, [group.id]: [option.id] };
    });

  const clearGroup = (group) => setSelected((s) => ({ ...s, [group.id]: [] }));

  const submit = (event) => {
    event.preventDefault();
    if (missing.length > 0) return;
    if (onAdd(buildLine(item, chosen, quantity, instructions))) onClose();
  };

  const missingText =
    missing.length > 0
      ? `Choose ${missing.map((g) => g.name).join(missing.length > 2 ? ', ' : ' and ')} to continue.`
      : '';

  return (
    <BottomSheet
      onClose={onClose}
      labelledBy={titleId}
      footer={
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-ink-soft">Quantity</span>
            <QuantityStepper value={quantity} onChange={setQuantity} label={item.name} />
          </div>
          <p id={hintId} role="status" aria-live="polite" className={`text-sm font-medium text-rose-700 ${missingText ? '' : 'sr-only'}`}>
            {missingText}
          </p>
          <Button type="submit" form={`item-form-${item.id}`} block disabled={missing.length > 0 || item.is_sold_out} aria-describedby={hintId}>
            {item.is_sold_out ? 'Sold out right now' : `Add to cart - ${formatPaise(totalPaise)}`}
          </Button>
        </div>
      }
    >
      <form id={`item-form-${item.id}`} onSubmit={submit}>
        <div className="relative">
          <DishImage item={item} variant="hero" className={`w-full ${item.photo_url ? "h-56" : "h-40"}`} iconClass="size-20" />
          <span aria-hidden="true" className="absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-white/80" />
        </div>

        <div className="px-4 pb-4 pt-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="display text-[26px] font-extrabold leading-tight text-ink">
              <DietMark diet={item.diet} size={20} className="mr-2 -translate-y-0.5" />
              {item.name}
            </h2>
            <p className="shrink-0 pt-1 text-xl font-extrabold tabular-nums text-ink">{formatMoney(item.price)}</p>
          </div>
          {item.description && <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{item.description}</p>}

          {groups.map((group) => {
            const picked = selected[group.id] ?? [];
            const headingId = `${titleId}-g${group.id}`;
            return (
              <section
                key={group.id}
                role={group.multi_select ? 'group' : 'radiogroup'}
                aria-labelledby={headingId}
                aria-required={group.required && !group.multi_select ? true : undefined}
                className="mt-5"
              >
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-extrabold text-ink">
                    {group.name}
                    {group.required ? (
                      <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-brand-800">
                        Required
                      </span>
                    ) : (
                      <span className="text-xs font-semibold text-ink-soft">
                        Optional{group.multi_select ? ', pick any' : ''}
                      </span>
                    )}
                  </h3>
                  {!group.required && !group.multi_select && picked.length > 0 && (
                    <button
                      type="button"
                      onClick={() => clearGroup(group)}
                      className="min-h-11 rounded-lg px-2 text-sm font-semibold text-brand-700 underline underline-offset-2"
                      aria-label={`Clear ${group.name}`}
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="mt-1 divide-y divide-line overflow-hidden rounded-[20px] ring-1 ring-inset ring-line">
                  {group.options.map((option) => {
                    const checked = picked.includes(option.id);
                    const delta = formatDelta(option.price);
                    return (
                      <label
                        key={option.id}
                        className={`flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 has-[:focus-visible]:outline-3 has-[:focus-visible]:-outline-offset-3 has-[:focus-visible]:outline-brand-800 ${
                          checked ? 'bg-brand-50' : 'bg-white hover:bg-page'
                        }`}
                      >
                        <input
                          type={group.multi_select ? 'checkbox' : 'radio'}
                          name={`${titleId}-${group.id}`}
                          checked={checked}
                          onChange={() => choose(group, option)}
                          className="size-5 shrink-0 accent-brand-600 focus-visible:outline-none"
                        />
                        <span className="min-w-0 flex-1 text-base font-medium text-ink">{option.name}</span>
                        {delta && <span className="shrink-0 text-sm font-semibold text-ink-soft">{delta}</span>}
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div className="mt-5">
            <label htmlFor={`${titleId}-instructions`} className="flex items-baseline justify-between gap-2 text-base font-extrabold text-ink">
              <span>Cooking instructions</span>
              <span className="text-xs font-semibold text-ink-soft">Optional</span>
            </label>
            <textarea
              id={`${titleId}-instructions`}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={MAX_INSTRUCTIONS}
              rows={2}
              placeholder="e.g. less spicy, no onions"
              className="mt-2 block w-full resize-none rounded-2xl border-0 bg-page px-3 py-2.5 text-ink ring-1 ring-inset ring-line placeholder:text-ink-soft/70"
            />
            <p className="mt-1 text-right text-xs text-ink-soft" aria-hidden="true">
              {`${instructions.length}/${MAX_INSTRUCTIONS}`}
            </p>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
