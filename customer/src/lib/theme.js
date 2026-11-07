import { buildTheme, DEFAULT_THEME, HEX_RE } from '../../../shared/theme.js';
import { getJSON, setJSON } from './storage';

// The restaurant's colours (set in the admin panel) arrive with the menu / order. We turn them into the Tailwind
// theme variables (--color-brand-*, --color-saffron-*) on <html>, so every bg-brand-600 / text-brand-700 re-colours.
// The last theme is remembered on this device so the next page load has no flash of the default colours.

const KEY = 'mezmitra_theme';
let applied = '';

const clean = (theme) => ({
  primary: HEX_RE.test(theme?.primary ?? '') ? theme.primary.toLowerCase() : DEFAULT_THEME.primary,
  accent: HEX_RE.test(theme?.accent ?? '') ? theme.accent.toLowerCase() : DEFAULT_THEME.accent,
});

export function applyTheme(theme, { remember = true } = {}) {
  const t = clean(theme);
  const id = `${t.primary}|${t.accent}`;
  if (id === applied) return;
  applied = id;

  const { vars, brand } = buildTheme(t);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  // Colour the phone's address bar / status bar to match.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', brand[700]);
  if (remember) setJSON(KEY, t);
}

/** Call once before the first render. */
export function applyStoredTheme() {
  const saved = getJSON(KEY, null);
  if (saved) applyTheme(saved, { remember: false });
}

/** The current button colour, for third-party widgets (Razorpay Checkout) that need a literal value. */
export function brandColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-brand-600').trim() || DEFAULT_THEME.primary;
}
