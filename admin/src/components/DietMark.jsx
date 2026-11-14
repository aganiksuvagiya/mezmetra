// The Indian food-type marker: a square with a dot (green = vegetarian, red = non-vegetarian), the way menus and food apps show it.
// Egg is amber. Jain is the green mark with a small "Jain" label. Always read by screen readers as a word, never by colour alone.

export const DIET_LABELS = { veg: 'Vegetarian', egg: 'Contains egg', nonveg: 'Non-vegetarian', jain: 'Jain' };

const COLOUR = { veg: '#15803d', jain: '#15803d', egg: '#d97706', nonveg: '#b91c1c' };

export default function DietMark({ diet, size = 16, className = '' }) {
  if (!diet || !DIET_LABELS[diet]) return null;
  const colour = COLOUR[diet];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`} title={DIET_LABELS[diet]}>
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="14" height="14" rx="2" fill="#fff" stroke={colour} strokeWidth="1.5" />
        {diet === 'nonveg' ? <path d="M8 4.2 12 11.2H4z" fill={colour} /> : <circle cx="8" cy="8" r="3.4" fill={colour} />}
      </svg>
      {diet === 'jain' && <span className="text-[10px] font-bold uppercase tracking-wide text-green-700">Jain</span>}
      <span className="sr-only">{DIET_LABELS[diet]}</span>
    </span>
  );
}
