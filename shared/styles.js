// The five "designs" a restaurant can give its customer pages (Admin -> Appearance). A design is more than colours: it sets the
// typeface, the corners, the look of the page and of the cards, and how the dishes are laid out. The restaurant's own two
// colours (shared/theme.js) are chosen separately and work with every design.
// Shared by the customer app (applies it) and the admin panel (live preview), so the owner sees what diners get. Plain JS.

export const DEFAULT_STYLE = 'classic';

/**
 * list    how the dishes of a category are laid out: rows (photo at the right), menu (printed-menu lines with dotted leaders),
 *         grid (two photo cards per row), compact (dense text lines, no photos) or stack (one big photo card per dish)
 * header  the top of the menu: row (logo, name, table) or center (centred name, like the top of a printed menu)
 * chips   the category and food-type switches: pill, underline or square
 * dock    the bottom bar: glass (frosted, rounded top), flat (plain bar with a hairline) or float (a rounded bar lifted off the edge)
 * dark    a dark page (the phone's status bar and the page background follow)
 */
export const STYLES = {
  classic: {
    name: 'Classic',
    blurb: 'Clean, friendly and familiar, like an iPhone app.',
    list: 'rows',
    header: 'row',
    chips: 'pill',
    dock: 'glass',
    dark: false,
    tokens: {
      page: '#f2f2f7',
      canvas: '#e5e5ea',
      inverse: '#1c1c1e',
      onInverse: '#ffffff',
      card: '#ffffff',
      ink: '#1c1c1e',
      inkSoft: '#636366',
      line: '#d9d9de',
      fill: 'rgb(0 0 0 / 0.06)',
      fillStrong: 'rgb(0 0 0 / 0.1)',
      font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
      radius: { sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', '4xl': '2rem' },
      surface: '1.125rem',
      chip: '9999px',
    },
  },
  bistro: {
    name: 'Bistro',
    blurb: 'A printed menu: serif type, warm paper, dotted lines to the price.',
    list: 'menu',
    header: 'center',
    chips: 'underline',
    dock: 'flat',
    dark: false,
    tokens: {
      page: '#faf5ec',
      canvas: '#efe6d6',
      inverse: '#2b2118',
      onInverse: '#fffdf8',
      card: '#fffdf8',
      ink: '#2b2118',
      inkSoft: '#6f5f50',
      line: '#e3d8c6',
      fill: 'rgb(60 40 20 / 0.07)',
      fillStrong: 'rgb(60 40 20 / 0.12)',
      font: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif',
      radius: { sm: '1px', md: '2px', lg: '3px', xl: '4px', '2xl': '6px', '3xl': '8px', '4xl': '12px' },
      surface: '4px',
      chip: '3px',
    },
  },
  gallery: {
    name: 'Gallery',
    blurb: 'Big appetising photos in a grid, soft rounded cards.',
    list: 'grid',
    header: 'row',
    chips: 'pill',
    dock: 'float',
    dark: false,
    tokens: {
      page: '#ffffff',
      canvas: '#efefec',
      inverse: '#161616',
      onInverse: '#ffffff',
      card: '#f6f6f3',
      ink: '#161616',
      inkSoft: '#5f5f63',
      line: '#e6e6e1',
      fill: 'rgb(0 0 0 / 0.055)',
      fillStrong: 'rgb(0 0 0 / 0.1)',
      font: 'ui-rounded, "SF Pro Rounded", "Nunito", -apple-system, BlinkMacSystemFont, "Inter Variable", system-ui, "Segoe UI", Roboto, sans-serif',
      radius: { sm: '0.375rem', md: '0.5rem', lg: '0.75rem', xl: '1rem', '2xl': '1.25rem', '3xl': '1.75rem', '4xl': '2.25rem' },
      surface: '1.5rem',
      chip: '9999px',
    },
  },
  minimal: {
    name: 'Minimal',
    blurb: 'Sharp, dense and quick to scan. Best for a long menu.',
    list: 'compact',
    header: 'row',
    chips: 'square',
    dock: 'flat',
    dark: false,
    tokens: {
      page: '#ffffff',
      canvas: '#efefef',
      inverse: '#0a0a0a',
      onInverse: '#ffffff',
      card: '#ffffff',
      ink: '#0a0a0a',
      inkSoft: '#5c5c5c',
      line: '#e2e2e2',
      fill: 'rgb(0 0 0 / 0.05)',
      fillStrong: 'rgb(0 0 0 / 0.09)',
      font: '"Helvetica Neue", Helvetica, Arial, "Inter Variable", ui-sans-serif, system-ui, sans-serif',
      radius: { sm: '1px', md: '2px', lg: '2px', xl: '3px', '2xl': '4px', '3xl': '4px', '4xl': '8px' },
      surface: '2px',
      chip: '2px',
    },
  },
  night: {
    name: 'Night',
    blurb: 'Dark and moody, one big photo card per dish. For bars and lounges.',
    list: 'stack',
    header: 'row',
    chips: 'pill',
    dock: 'glass',
    dark: true,
    tokens: {
      page: '#0d0d0f',
      canvas: '#000000',
      inverse: '#2b2b32',
      onInverse: '#f4f4f6',
      card: '#1a1a1d',
      ink: '#f4f4f6',
      inkSoft: '#a4a4ad',
      line: '#2e2e34',
      fill: 'rgb(255 255 255 / 0.09)',
      fillStrong: 'rgb(255 255 255 / 0.15)',
      font: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter Variable", ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      radius: { sm: '0.375rem', md: '0.5rem', lg: '0.625rem', xl: '0.875rem', '2xl': '1.125rem', '3xl': '1.625rem', '4xl': '2rem' },
      surface: '1.25rem',
      chip: '9999px',
    },
  },
};

export const STYLE_IDS = Object.keys(STYLES);

export const isStyle = (id) => typeof id === 'string' && Object.hasOwn(STYLES, id);

/** The style for an id; anything unknown (or missing) is the default. */
export const styleOf = (id) => STYLES[isStyle(id) ? id : DEFAULT_STYLE];

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `amount` of colour `a` on top of colour `b`, as #rrggbb. */
const mix = (a, b, amount) => {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return toHex(x.map((v, i) => v * amount + y[i] * (1 - amount)));
};

/**
 * The CSS custom properties that turn the customer app into this design. `brand` is the shade map from buildTheme(); the
 * restaurant's own colours are mixed in here: link text and soft tints are the brand colour on a light page, and lighter shades
 * of it on a dark one.
 * @returns {{ vars: Record<string,string>, style: object, id: string }}
 */
export function buildStyleVars(id, brand) {
  const styleId = isStyle(id) ? id : DEFAULT_STYLE;
  const style = STYLES[styleId];
  const t = style.tokens;
  const vars = {
    '--color-page': t.page,
    '--color-canvas': t.canvas,
    '--color-inverse': t.inverse,
    '--color-on-inverse': t.onInverse,
    '--color-card': t.card,
    '--color-ink': t.ink,
    '--color-ink-soft': t.inkSoft,
    '--color-line': t.line,
    '--color-fill': t.fill,
    '--color-fill-strong': t.fillStrong,
    '--font-sans': t.font,
    '--radius-surface': t.surface,
    '--radius-chip': t.chip,
    '--color-link': style.dark ? brand[300] : brand[700],
    '--color-tint': style.dark ? mix(brand[500], t.card, 0.16) : brand[50],
    '--color-tint-strong': style.dark ? mix(brand[500], t.card, 0.28) : brand[100],
  };
  for (const [size, value] of Object.entries(t.radius)) vars[`--radius-${size}`] = value;
  return { vars, style, id: styleId };
}
