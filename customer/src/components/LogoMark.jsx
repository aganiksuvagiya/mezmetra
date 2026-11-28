import { useId } from 'react';
import { LOGO } from '../../../shared/logo.js';

/** The MezMitra mark. Decorative: the name is always written beside it. */
export default function LogoMark({ size = 40, className = '' }) {
  const shade = `mark${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={shade} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={LOGO.from} />
          <stop offset="1" stopColor={LOGO.to} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx={LOGO.radius} fill={`url(#${shade})`} />
      <circle {...LOGO.head} fill="#fff" />
      <path d={LOGO.arms} fill="none" stroke="#fff" strokeWidth={LOGO.stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
