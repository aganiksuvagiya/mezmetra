import { useSyncExternalStore } from 'react';
import { buildTheme, DEFAULT_THEME, HEX_RE } from '../../../shared/theme.js';
import { buildStyleVars, DEFAULT_STYLE, isStyle, styleOf } from '../../../shared/styles.js';
import { getJSON, setJSON } from './storage';

// The restaurant's look (set in the admin panel, Appearance) arrives with the menu / order: two colours and one of five designs.
// We turn the colours into the Tailwind theme variables (--color-brand-*, --color-saffron-*) and the design into the page, card,
// text and corner variables on <html>, so every bg-brand-600 / bg-card / rounded-xl re-colours and re-shapes. Components that
// lay things out differently per design read it with useDesign().
// The last look is remembered on this device so the next page load has no flash of the default one.

const KEY = 'mezmitra_theme';
let applied = '';
let currentStyle = DEFAULT_STYLE;
const listeners = new Set();

const clean = (theme) => ({
  primary: HEX_RE.test(theme?.primary ?? '') ? theme.primary.toLowerCase() : DEFAULT_THEME.primary,
  accent: HEX_RE.test(theme?.accent ?? '') ? theme.accent.toLowerCase() : DEFAULT_THEME.accent,
  style: isStyle(theme?.style) ? theme.style : DEFAULT_STYLE,
});

export function applyTheme(theme, { remember = true } = {}) {
  const t = clean(theme);
  const id = `${t.primary}|${t.accent}|${t.style}`;
  if (id === applied) return;
  applied = id;

  const { vars, brand } = buildTheme(t);
  const design = buildStyleVars(t.style, brand);
  const root = document.documentElement;
  for (const [name, value] of Object.entries({ ...vars, ...design.vars })) root.style.setProperty(name, value);
  root.dataset.design = design.id;
  root.style.colorScheme = design.style.dark ? 'dark' : 'light';
  // Colour the phone's address bar / status bar to match.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', design.style.dark ? design.style.tokens.page : brand[700]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', design.style.dark ? 'dark' : 'light');
  if (remember) setJSON(KEY, t);

  if (currentStyle !== design.id) {
    currentStyle = design.id;
    listeners.forEach((l) => l());
  }
}

/** The neutral Classic look, with the colours last used on this device (for pages that are not any restaurant's, like the front page). */
export function applyClassicLook() {
  const saved = getJSON(KEY, null);
  applyTheme({ ...(saved ?? {}), style: 'classic' }, { remember: false });
}

/** Call once before the first render. */
export function applyStoredTheme() {
  const saved = getJSON(KEY, null);
  if (saved) applyTheme(saved, { remember: false });
}

/**
 * The restaurant's chosen design: { id, name, list, header, chips, dock, dark, tokens }. `list` says how dishes are laid out
 * (rows, menu, grid, compact or stack), `header` how the menu starts, `chips` the shape of the switches, `dock` the bottom bar.
 * Re-renders the component when the design changes.
 */
export function useDesign() {
  const id = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentStyle,
  );
  return { id, ...styleOf(id) };
}

/** The current button colour, for third-party widgets (Razorpay Checkout) that need a literal value. */
export function brandColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-brand-600').trim() || DEFAULT_THEME.primary;
}
