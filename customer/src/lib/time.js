// Times are ISO-8601 UTC strings from the API; show them in the browser's own locale and time zone.

// On a 24-hour clock the hour is two digits (00:10, 07:42); on a 12-hour clock it is not (7:42 pm).
const HOUR = (() => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric';
  } catch {
    return 'numeric';
  }
})();

/** "7:42 pm" for today, "29 Oct, 7:42 pm" for another day (formats follow the browser's locale). */
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: HOUR, minute: '2-digit' })
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: HOUR, minute: '2-digit' });
}
