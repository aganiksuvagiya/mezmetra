import { useState } from 'react';
import { assetUrl } from '../lib/api';

// Where the colour blobs sit; picked by dish id so neighbouring dishes look different but stay on-palette.
const SPOTS = [
  [18, 20, 84, 86],
  [84, 16, 12, 88],
  [22, 86, 88, 12],
  [80, 82, 14, 16],
];

/** A bowl with steam: a calm "no photo yet" picture that is drawn with the restaurant's own colours. */
function Bowl({ className, style }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      <path d="M9 31h46c0 13-10 21-23 21S9 44 9 31z" />
      <path d="M22 57h20" />
      <path d="M23 22c0-3.4 3-3.4 3-6.8M32 22c0-3.4 3-3.4 3-6.8M41 22c0-3.4 3-3.4 3-6.8" strokeOpacity="0.6" />
    </svg>
  );
}

/**
 * Photo, or a tile drawn from the theme colours when there is no photo (or it fails to load).
 * variant="thumb" is light (list rows, cart); variant="hero" is deep, for cards with white text over the picture.
 */
export default function DishImage({ item, className = '', iconClass = 'size-10', variant = 'thumb' }) {
  const [failed, setFailed] = useState(false);
  const src = assetUrl(item.photo_url);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={`bg-brand-50 object-cover ${className}`}
      />
    );
  }

  const [x1, y1, x2, y2] = SPOTS[Math.abs(Number(item.id) || 0) % SPOTS.length];
  const background =
    variant === 'hero'
      ? `radial-gradient(90% 70% at ${x1}% ${y1}%, color-mix(in oklab, var(--color-saffron-500) 55%, transparent), transparent 66%),
         radial-gradient(80% 80% at ${x2}% ${y2}%, var(--color-brand-400), transparent 72%),
         linear-gradient(165deg, var(--color-brand-600), var(--color-brand-900))`
      : `radial-gradient(75% 75% at ${x1}% ${y1}%, color-mix(in oklab, var(--color-saffron-300) 65%, transparent), transparent 70%),
         linear-gradient(150deg, var(--color-brand-100), var(--color-brand-200))`;

  return (
    <div aria-hidden="true" style={{ background }} className={`relative grid select-none place-items-center overflow-hidden ${className}`}>
      <Bowl className={`${iconClass} ${variant === 'hero' ? 'text-white/25' : 'text-brand-700/60'}`} />
    </div>
  );
}
