/** Only the keys whose value differs - PATCH requests send just what the person changed. */
export function changedFields(before, after) {
  const out = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out;
}

/** True for "12", "12.5", "12.50" (non-negative, at most two decimals). */
export const isMoneyString = (s) => /^\d+(\.\d{1,2})?$/.test(String(s).trim());

let counter = 0;
/** Stable React keys for rows the person can add/remove (option groups, options). */
export const nextKey = () => `k${++counter}`;
