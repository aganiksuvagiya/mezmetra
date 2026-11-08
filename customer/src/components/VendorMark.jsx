import { useState } from 'react';
import { assetUrl } from '../lib/api';

const SIZES = {
  lg: 'size-14 rounded-[16px] text-[26px]',
  sm: 'size-11 rounded-[13px] text-xl',
};

/**
 * The restaurant's mark: its uploaded logo on a white tile, or (no logo / logo failed to load) a tile in the restaurant's
 * own colour with its first letter, like an iPhone app icon.
 */
export default function VendorMark({ vendor, size = 'lg' }) {
  const [failed, setFailed] = useState(false);
  const src = assetUrl(vendor.logo_url);
  const box = SIZES[size] ?? SIZES.lg;

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        decoding="async"
        onError={() => setFailed(true)}
        className={`${box} shrink-0 bg-white object-contain p-1.5 shadow-float ring-1 ring-inset ring-black/10`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center bg-gradient-to-br from-brand-500 to-brand-800 font-extrabold text-white shadow-float ring-1 ring-inset ring-white/20`}
    >
      {vendor.name.trim().charAt(0).toUpperCase() || 'M'}
    </span>
  );
}
