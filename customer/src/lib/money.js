// One currency format for the whole app: en-IN rupees. Whole amounts drop the decimals (₹499), anything else
// shows two (₹499.50). Bills pass { fixed: true } when any line has paise so the column lines up.

const withDecimals = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeRupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Integer paise. All client-side arithmetic is done in paise to avoid floating point drift. */
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);

export const isWholeRupees = (rupees) => toPaise(rupees) % 100 === 0;

export function formatMoney(rupees, { fixed = false } = {}) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return '';
  return fixed || !isWholeRupees(n) ? withDecimals.format(n) : wholeRupees.format(n);
}

export const formatPaise = (paise, opts) => formatMoney(paise / 100, opts);

/** "+₹60" for a price delta; empty for free options. */
export const formatDelta = (rupees) => (toPaise(rupees) > 0 ? `+${formatMoney(rupees)}` : '');

/** True when any of the amounts has paise, i.e. a bill should show every amount with two decimals. */
export const needsDecimals = (...amounts) => amounts.some((a) => !isWholeRupees(a));
