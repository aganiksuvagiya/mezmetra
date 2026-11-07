// One place for every number/date the UI prints, so formats never drift between pages.

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrCompact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 });
const isBlank = (v) => v === null || v === undefined || v === '';

/** ₹499, ₹1,419, ₹499.50 - whole rupees have no decimals, anything else always has two. */
export function formatMoney(value) {
  const n = isBlank(value) ? NaN : Number(value);
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n - Math.round(n)) < 0.005 ? inr0.format(Math.round(n)) : inr2.format(n);
}

/** ₹1.4K - only for tight spots like chart labels (the full value is always available in a title). */
export function formatMoneyCompact(value) {
  const n = isBlank(value) ? NaN : Number(value);
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) < 1000 ? formatMoney(Math.round(n)) : inrCompact.format(n);
}

export const formatNumber = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);

// ---- dates -----------------------------------------------------------------------------------------------------

const formatters = new Map();

function formatterFor(timeZone, withSeconds) {
  const key = `${timeZone ?? ''}|${withSeconds ? 's' : ''}`;
  let f = formatters.get(key);
  if (!f) {
    const options = {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: true,
    };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-US', options); // unknown zone: fall back to the browser's
    }
    formatters.set(key, f);
  }
  return f;
}

function partsOf(value, timeZone, withSeconds = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const p = {};
  for (const part of formatterFor(timeZone, withSeconds).formatToParts(date)) p[part.type] = part.value;
  p.dayPeriod = (p.dayPeriod ?? '').toLowerCase();
  return p;
}

/** 29 Oct 2026, 12:31 am - in the vendor's time zone. */
export function formatDateTime(value, timeZone) {
  const p = partsOf(value, timeZone);
  return p ? `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod}` : '—';
}

/** 12:31 am */
export function formatTime(value, timeZone) {
  const p = partsOf(value, timeZone);
  return p ? `${p.hour}:${p.minute} ${p.dayPeriod}` : '—';
}

/** 12:31:05 am - for "Updated ..." labels. */
export function formatClock(value, timeZone) {
  const p = partsOf(value, timeZone, true);
  return p ? `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod}` : '—';
}

const dayFormatters = {
  short: new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
  long: new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
};

function ymdToDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); // a calendar date, so UTC keeps the weekday stable
}

/** "2026-10-27" -> "Mon 27" */
export function formatDayShort(ymd) {
  const parts = dayFormatters.short.formatToParts(ymdToDate(ymd));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')}`;
}

/** "2026-10-27" -> "Mon 27 Oct 2026" */
export function formatDayLong(ymd) {
  const parts = dayFormatters.long.formatToParts(ymdToDate(ymd));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
}

// ---- small text helpers ----------------------------------------------------------------------------------------

export const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export function orderItemsSummary(items = [], max = 3) {
  const shown = items.slice(0, max).map((i) => `${i.quantity}× ${i.name}`);
  const more = items.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` +${more} more` : '');
}

export const slug = (text) => String(text).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
