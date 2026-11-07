// Turns a restaurant's two chosen colours into the full set of shades the customer app uses.
// Shared by the customer app (applies them as CSS variables) and the admin panel (live preview), so what the
// owner sees while choosing is exactly what diners get. Plain JS, no dependencies.

export const DEFAULT_THEME = { primary: '#2f6f62', accent: '#e8872a' };

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** '#RRGGBB' -> [r, g, b], or null when it is not a valid colour. */
export function hexToRgb(hex) {
  if (!HEX_RE.test(String(hex ?? ''))) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;

function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio between two [r, g, b] colours (1 to 21). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hsl = (h, s, l) => rgbToHex(hslToRgb([h, clamp(s, 0, 1), clamp(l, 0.03, 0.985)]));

/** Darken (keeping hue and saturation) until `against` text/background reaches the contrast ratio. */
function darkenToContrast(h, s, l, against, min) {
  let light = l;
  while (light > 0.06 && contrast(hslToRgb([h, s, light]), against) < min) light -= 0.01;
  return light;
}

const WHITE = [255, 255, 255];

/**
 * @param {{primary?: string, accent?: string}} theme  #rrggbb colours (invalid or missing ones fall back to the defaults)
 * @returns {{ vars: Record<string,string>, primaryAdjusted: boolean, brand: Record<number,string>, accent: Record<number,string> }}
 *   `vars` are the CSS custom properties the customer app's Tailwind theme reads.
 *   `primaryAdjusted` is true when the chosen primary had to be darkened so white text on it stays readable.
 */
export function buildTheme(theme = {}) {
  const primaryRgb = hexToRgb(theme.primary) ?? hexToRgb(DEFAULT_THEME.primary);
  const accentRgb = hexToRgb(theme.accent) ?? hexToRgb(DEFAULT_THEME.accent);

  // --- Brand (primary): 600 is the colour of buttons, so white text on it must be readable (>= 4.5:1). ---
  const [h, rawS, rawL] = rgbToHsl(primaryRgb);
  const s = clamp(rawS, 0.12, 0.95);
  const l600 = darkenToContrast(h, s, rawL, WHITE, 4.5);
  const primaryAdjusted = rawL - l600 > 0.02;
  const l500 = Math.min(0.78, l600 + 0.06);
  const tint = (target, sat) => hsl(h, s * sat, Math.max(target, l500 + 0.07));
  const brand = {
    50: hsl(h, Math.min(s, 0.45), 0.96),
    100: hsl(h, Math.min(s, 0.5), 0.91),
    200: hsl(h, s * 0.65, 0.82),
    300: tint(0.7, 0.62),
    400: tint(0.57, 0.72),
    500: hsl(h, s, l500),
    600: hsl(h, s, l600),
    700: hsl(h, s, l600 - 0.07),
    800: hsl(h, s, l600 - 0.14),
    900: hsl(h, s, l600 - 0.21),
  };

  // --- Accent: used for small highlights (badges, chef's pick). 100 is a pale tint, 700 is text on it. ---
  const [ah, aRawS] = rgbToHsl(accentRgb);
  const as = clamp(aRawS, 0.2, 0.95);
  const accent100 = hsl(ah, Math.min(as, 0.85), 0.92);
  const l700 = darkenToContrast(ah, as, 0.45, hexToRgb(accent100), 4.5);
  const accent = {
    100: accent100,
    300: hsl(ah, as, 0.73),
    500: rgbToHex(accentRgb),
    700: hsl(ah, as, l700),
  };

  const vars = {};
  for (const [k, v] of Object.entries(brand)) vars[`--color-brand-${k}`] = v;
  for (const [k, v] of Object.entries(accent)) vars[`--color-saffron-${k}`] = v;
  return { vars, primaryAdjusted, brand, accent };
}
