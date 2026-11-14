import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJSON, removeItem, setJSON } from './storage';
import { toPaise } from './money';

// Server limits (see POST /api/public/t/:token/orders): 20 per line, 40 lines, 200 chars of instructions.
export const MAX_QTY = 20;
export const MAX_LINES = 40;
export const MAX_INSTRUCTIONS = 200;
export const MAX_NOTE = 300;

const cartKey = (tableToken) => `mezmitra_cart_${tableToken}`;

const normalise = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Two lines are "identical" (and merge) when dish, chosen options and cooking instructions all match. */
export const lineKey = (itemId, optionIds, instructions) =>
  `${itemId}:${[...optionIds].sort((a, b) => a - b).join('.')}:${normalise(instructions)}`;

/**
 * A cart line: { key, itemId, name, unitPrice (rupees, options included - display only), quantity, instructions,
 * options: [{ id, group, name, price }] }. Prices here are for display; the server re-prices the order.
 */
export function buildLine(item, chosenOptions, quantity, instructions) {
  const optionPaise = chosenOptions.reduce((sum, o) => sum + toPaise(o.price), 0);
  const options = chosenOptions.map((o) => ({ id: o.id, group: o.group, name: o.name, price: o.price }));
  const text = String(instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS);
  return {
    key: lineKey(item.id, options.map((o) => o.id), text),
    itemId: item.id,
    name: item.name,
    unitPrice: (toPaise(item.price) + optionPaise) / 100,
    quantity,
    instructions: text,
    options,
  };
}

function sanitiseLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = Number(raw.itemId);
  const quantity = Math.floor(Number(raw.quantity));
  const unitPrice = Number(raw.unitPrice);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || !(quantity >= 1)) return null;
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((o) => ({ id: Number(o?.id), group: String(o?.group ?? ''), name: String(o?.name ?? ''), price: Number(o?.price) || 0 }))
    .filter((o) => Number.isInteger(o.id) && o.id > 0);
  const instructions = String(raw.instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS);
  return {
    key: lineKey(itemId, options.map((o) => o.id), instructions),
    itemId,
    name: String(raw.name ?? 'Dish'),
    unitPrice,
    quantity: Math.min(quantity, MAX_QTY),
    instructions,
    options,
  };
}

function mergeLines(lines) {
  const byKey = new Map();
  for (const line of lines) {
    const existing = byKey.get(line.key);
    byKey.set(line.key, existing ? { ...existing, quantity: Math.min(MAX_QTY, existing.quantity + line.quantity) } : line);
  }
  return [...byKey.values()];
}

export function loadLines(tableToken) {
  const raw = getJSON(cartKey(tableToken), []);
  if (!Array.isArray(raw)) return [];
  return mergeLines(raw.map(sanitiseLine).filter(Boolean)).slice(0, MAX_LINES);
}

const saveLines = (tableToken, lines) => {
  if (lines.length === 0) removeItem(cartKey(tableToken));
  else setJSON(cartKey(tableToken), lines);
};

export const lineTotalPaise = (line) => toPaise(line.unitPrice) * line.quantity;

/**
 * Compare the cart with a fresh menu: drop lines whose dish (or chosen option) is gone, and refresh names and
 * prices. Returns { lines, dropped: [dish names], changed }.
 */
export function reconcileLines(lines, items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const dropped = [];
  const next = [];

  for (const line of lines) {
    const item = byId.get(line.itemId);
    if (!item || item.is_sold_out) {
      dropped.push(item?.name ?? line.name);
      continue;
    }
    const groups = item.option_groups ?? [];
    const index = new Map();
    for (const group of groups) for (const option of group.options) index.set(option.id, { group, option });

    const options = [];
    let valid = true;
    for (const chosen of line.options) {
      const hit = index.get(chosen.id);
      if (!hit) {
        valid = false;
        break;
      }
      options.push({ id: hit.option.id, group: hit.group.name, name: hit.option.name, price: hit.option.price });
    }
    if (valid) {
      for (const group of groups) {
        const picked = options.filter((o) => group.options.some((go) => go.id === o.id)).length;
        if ((group.required && picked === 0) || (!group.multi_select && picked > 1)) valid = false;
      }
    }
    if (!valid) {
      dropped.push(item.name);
      continue;
    }

    const rebuilt = buildLine(item, options, line.quantity, line.instructions);
    next.push(rebuilt);
  }

  const merged = mergeLines(next);
  const changed = dropped.length > 0 || JSON.stringify(merged) !== JSON.stringify(lines);
  return { lines: merged, dropped: [...new Set(dropped)], changed };
}

/** Friendly sentence for lines that `reconcileLines` removed. */
export function describeDropped(dropped) {
  if (dropped.length === 1) return `${dropped[0]} is no longer available, so we removed it from your cart.`;
  return `These dishes are no longer available and were removed from your cart: ${dropped.join(', ')}.`;
}

/** The request body for POST /orders. No prices - the server computes them. */
export function buildOrderBody(lines, note, payPref, tableCode = '') {
  return {
    items: lines.map((l) => ({
      item_id: l.itemId,
      quantity: l.quantity,
      instructions: l.instructions,
      option_ids: l.options.map((o) => o.id),
    })),
    note: String(note ?? '').trim(),
    pay_pref: payPref,
    ...(tableCode ? { table_code: tableCode } : {}), // only when the restaurant asks diners for the code on the table
  };
}

/**
 * Cart for one table, persisted in localStorage (`mezmitra_cart_<tableToken>`). Every mutation writes to storage
 * synchronously (not in an effect) so a navigation right after `clear()` can never resurrect stale items.
 */
export function useCart(tableToken) {
  const [lines, setLines] = useState(() => loadLines(tableToken));
  const ref = useRef(lines);

  const commit = useCallback(
    (next) => {
      ref.current = next;
      saveLines(tableToken, next);
      setLines(next);
    },
    [tableToken],
  );

  // Keep several open tabs of the same table in sync.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== cartKey(tableToken)) return;
      const next = loadLines(tableToken);
      ref.current = next;
      setLines(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [tableToken]);

  const getLines = useCallback(() => ref.current, []);

  /** Add a line, merging with an identical one. Returns { ok, capped?, reason? }. */
  const add = useCallback(
    (line) => {
      const current = ref.current;
      const at = current.findIndex((l) => l.key === line.key);
      if (at === -1) {
        if (current.length >= MAX_LINES) return { ok: false, reason: 'full' };
        commit([...current, line]);
        return { ok: true };
      }
      const wanted = current[at].quantity + line.quantity;
      commit(current.map((l, i) => (i === at ? { ...l, quantity: Math.min(wanted, MAX_QTY) } : l)));
      return { ok: true, capped: wanted > MAX_QTY };
    },
    [commit],
  );

  const setQuantity = useCallback(
    (key, quantity) => {
      const q = Math.max(1, Math.min(MAX_QTY, Math.floor(quantity)));
      commit(ref.current.map((l) => (l.key === key ? { ...l, quantity: q } : l)));
    },
    [commit],
  );

  /** Remove a line; returns what is needed to undo it with `restore`. */
  const remove = useCallback(
    (key) => {
      const current = ref.current;
      const index = current.findIndex((l) => l.key === key);
      if (index === -1) return null;
      commit(current.filter((l) => l.key !== key));
      return { line: current[index], index };
    },
    [commit],
  );

  const restore = useCallback(
    ({ line, index }) => {
      const current = ref.current;
      if (current.some((l) => l.key === line.key) || current.length >= MAX_LINES) return;
      const next = [...current];
      next.splice(Math.min(index, next.length), 0, line);
      commit(next);
    },
    [commit],
  );

  const clear = useCallback(() => {
    ref.current = [];
    removeItem(cartKey(tableToken));
    setLines([]);
  }, [tableToken]);

  const count = useMemo(() => lines.reduce((n, l) => n + l.quantity, 0), [lines]);
  const subtotalPaise = useMemo(() => lines.reduce((n, l) => n + lineTotalPaise(l), 0), [lines]);

  return { lines, count, subtotalPaise, getLines, add, setQuantity, remove, restore, replace: commit, clear };
}
