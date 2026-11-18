import { cx } from '../../lib/cx.js';

// A restaurant's first letter on a colour that stays the same for that name, so a row is recognised at a glance.
const TONES = [
  'bg-brand-100 text-brand-700',
  'bg-emerald-100 text-emerald-700',
  'bg-sky-100 text-sky-700',
  'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-700',
];

const toneFor = (name) => {
  let h = 0;
  for (const ch of String(name ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
};

export default function RestaurantAvatar({ name, suspended = false, size = 'md', className }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'grid shrink-0 place-items-center rounded-xl font-bold',
        size === 'lg' ? 'size-14 text-2xl' : 'size-11 text-lg',
        suspended ? 'bg-slate-200 text-slate-500' : toneFor(name),
        className,
      )}
    >
      {String(name ?? '?').trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
