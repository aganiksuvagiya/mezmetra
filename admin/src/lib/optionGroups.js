import { isMoneyString, nextKey } from './forms.js';

export const MAX_GROUPS = 10;
export const MAX_OPTIONS = 30;

export const emptyOption = () => ({ key: nextKey(), name: '', price: '' });
export const emptyGroup = () => ({ key: nextKey(), name: '', multi_select: false, required: false, options: [emptyOption()] });

/** API option groups -> editable rows (prices become strings so the inputs can hold partial numbers). */
export const groupsFromApi = (groups = []) =>
  groups.map((g) => ({
    key: nextKey(),
    name: g.name,
    multi_select: Boolean(g.multi_select),
    required: Boolean(g.required),
    options: g.options.map((o) => ({ key: nextKey(), name: o.name, price: Number(o.price) ? String(o.price) : '' })),
  }));

/** Editable rows -> the shape POST/PATCH expects. */
export const groupsToApi = (groups) =>
  groups.map((g) => ({
    name: g.name.trim(),
    multi_select: g.multi_select,
    required: g.required,
    options: g.options.map((o) => ({ name: o.name.trim(), price: o.price.trim() === '' ? 0 : Number(o.price) })),
  }));

/**
 * Returns an array parallel to `groups` of `{ name?, options: [{ name?, price? }], general? }`, or null when everything
 * is valid.
 */
export function validateGroups(groups) {
  let bad = false;
  const result = groups.map((g) => {
    const entry = { options: g.options.map(() => ({})) };
    if (!g.name.trim()) {
      entry.name = 'Enter a group name.';
      bad = true;
    } else if (g.name.trim().length > 80) {
      entry.name = 'Keep the name under 80 characters.';
      bad = true;
    }
    if (g.options.length === 0) {
      entry.general = 'Add at least one option.';
      bad = true;
    }
    g.options.forEach((o, i) => {
      if (!o.name.trim()) {
        entry.options[i].name = 'Enter a name.';
        bad = true;
      } else if (o.name.trim().length > 80) {
        entry.options[i].name = 'Too long (max 80).';
        bad = true;
      }
      const price = o.price.trim();
      if (price !== '' && (!isMoneyString(price) || Number(price) > 100000)) {
        entry.options[i].price = 'Use a number like 20 or 20.50.';
        bad = true;
      }
    });
    return entry;
  });
  return bad ? result : null;
}
