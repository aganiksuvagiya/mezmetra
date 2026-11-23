import { useState } from 'react';
import { assetUrl } from '../lib/api';

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
 * Photo, or a flat tile in the theme colour when there is no photo (or it fails to load).
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

  // No photo: a flat tile in the restaurant's own colour with the bowl on it.
  const tile = variant === 'hero' ? 'bg-brand-800' : 'bg-brand-50';
  return (
    <div aria-hidden="true" className={`relative grid select-none place-items-center overflow-hidden ${tile} ${className}`}>
      <Bowl className={`${iconClass} ${variant === 'hero' ? 'text-white/30' : 'text-brand-300'}`} />
    </div>
  );
}
