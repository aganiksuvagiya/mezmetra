import { useState } from 'react';
import { buildTheme, DEFAULT_THEME, HEX_RE } from '../../../shared/theme.js';
import { buildStyleVars, DEFAULT_STYLE, STYLE_IDS, STYLES, styleOf } from '../../../shared/styles.js';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, apiUrl } from '../lib/api.js';
import LogoCard from '../components/LogoCard.jsx';
import { cx } from '../lib/cx.js';
import { useAction, useDocumentTitle } from '../lib/hooks.js';

const PRESETS = [
  { id: 'teal', name: 'Teal & Saffron', primary: '#2f6f62', accent: '#e8872a' },
  { id: 'red', name: 'Spice Red', primary: '#b91c1c', accent: '#f59e0b' },
  { id: 'blue', name: 'Royal Blue', primary: '#1d4ed8', accent: '#f97316' },
  { id: 'green', name: 'Forest', primary: '#166534', accent: '#eab308' },
  { id: 'plum', name: 'Plum', primary: '#7e22ce', accent: '#f59e0b' },
  { id: 'coffee', name: 'Coffee', primary: '#7c4a2d', accent: '#d97706' },
  { id: 'ocean', name: 'Ocean', primary: '#0e7490', accent: '#f97316' },
  { id: 'midnight', name: 'Midnight', primary: '#1f2937', accent: '#f43f5e' },
];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** A "#rrggbb" field with a native colour picker and a text box that accepts typing/pasting. */
function ColourField({ id, label, hint, value, onChange }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  // Follow outside changes (preset buttons, reset) without fighting the user's typing.
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const invalid = !HEX_RE.test(text);

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="h-11 w-12 shrink-0 cursor-pointer rounded-xl border border-black/10 bg-white p-1"
        />
        <input
          id={id}
          type="text"
          value={text}
          onChange={(e) => {
            const next = e.target.value.trim();
            setText(next);
            if (HEX_RE.test(next)) onChange(next.toLowerCase());
          }}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint`}
          className={cx(
            'h-11 w-32 rounded-xl border bg-white px-3 font-mono text-sm uppercase text-slate-900',
            invalid ? 'border-red-400 ring-1 ring-red-300' : 'border-black/10',
          )}
        />
      </div>
      <p id={`${id}-hint`} className={cx('mt-1.5 text-xs', invalid ? 'text-red-700' : 'text-slate-500')}>
        {invalid ? 'Use a colour like #2f6f62 (a # and six letters or digits).' : hint}
      </p>
    </div>
  );
}

const TAB_ICONS = {
  Menu: <path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />,
  Search: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />,
  Cart: <path d="M6 7h12l-1 13H7L6 7zM9 7a3 3 0 0 1 6 0" />,
  Orders: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" />,
  Help: <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0" />,
};

const SAMPLE = [
  { name: 'Margherita Pizza', note: 'Fresh mozzarella and basil.', price: '₹499' },
  { name: 'Garlic Bread', note: 'Toasted with herb butter.', price: '₹149' },
  { name: 'Paneer Tikka', note: 'Smoky, with mint chutney.', price: '₹329' },
];

const VegMark = () => (
  <span className="grid size-3 shrink-0 place-items-center rounded-[3px] border border-green-700">
    <span className="size-1.5 rounded-full bg-green-700" />
  </span>
);

/** A flat picture tile for a sample dish (no photo needed in a preview). */
const Tile = ({ size, radius, bg, ring }) => (
  <span className="block shrink-0" style={{ width: size, height: size, borderRadius: radius, background: bg, boxShadow: ring }} />
);

/** The dishes of the preview in the layout of the chosen design: rows, printed-menu lines, a photo grid, a dense list or big cards. */
function SampleDishes({ style, brand, link, tint }) {
  const t = style.tokens;
  const line = `1px solid ${t.line}`;
  const price = { color: t.ink };
  const add = (extra = '') => (
    <span className={`inline-flex shrink-0 items-center justify-center text-[8px] font-extrabold uppercase ${extra}`} style={{ color: link, background: t.page, borderRadius: t.chip, boxShadow: `inset 0 0 0 1px ${t.line}` }}>
      Add +
    </span>
  );

  if (style.list === 'menu') {
    return (
      <div className="px-3" style={{ borderTop: line }}>
        {SAMPLE.slice(0, 2).map((d) => (
          <div key={d.name} className="flex gap-2 py-2" style={{ borderBottom: line }}>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5 text-[11px] font-semibold" style={{ color: t.ink }}>
                <span className="inline-flex items-center gap-1"><VegMark />{d.name}</span>
                <span className="mb-0.5 flex-1 border-b border-dotted" style={{ borderColor: t.inkSoft }} />
                <span style={price}>{d.price}</span>
              </p>
              <p className="mt-0.5 text-[8px] italic" style={{ color: t.inkSoft }}>{d.note}</p>
              <span className="mt-1.5 block">{add('px-2 py-0.5')}</span>
            </div>
            <Tile size="2.6rem" radius={t.radius.md} bg={tint} />
          </div>
        ))}
      </div>
    );
  }
  if (style.list === 'grid') {
    return (
      <div className="grid grid-cols-2 gap-2 px-3">
        {SAMPLE.slice(0, 2).map((d) => (
          <div key={d.name}>
            <div className="relative h-14" style={{ background: tint, borderRadius: t.radius['2xl'] }}>
              <span className="absolute bottom-1 right-1 grid size-5 place-items-center rounded-full bg-white text-[10px] font-extrabold" style={{ color: brand[700] }}>+</span>
            </div>
            <p className="mt-1 text-[10px] font-bold" style={{ color: t.ink }}>{d.name}</p>
            <p className="text-[10px] font-extrabold" style={{ color: t.ink }}>{d.price}</p>
          </div>
        ))}
      </div>
    );
  }
  if (style.list === 'compact') {
    return (
      <div className="px-3" style={{ borderTop: `2px solid ${t.ink}` }}>
        {SAMPLE.map((d) => (
          <div key={d.name} className="flex items-center gap-2 py-1.5" style={{ borderBottom: line }}>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: t.ink }}><VegMark />{d.name}</p>
              <p className="truncate text-[8px]" style={{ color: t.inkSoft }}>{d.note}</p>
            </div>
            <span className="text-[10px] font-semibold" style={{ color: t.ink }}>{d.price}</span>
            <span className="grid size-5 place-items-center text-[11px]" style={{ color: link, boxShadow: `inset 0 0 0 1px ${t.line}`, borderRadius: t.chip }}>+</span>
          </div>
        ))}
      </div>
    );
  }
  if (style.list === 'stack') {
    const d = SAMPLE[0];
    return (
      <div className="px-3">
        <div className="overflow-hidden" style={{ background: t.card, borderRadius: t.surface, boxShadow: `0 0 0 0.5px ${t.line}` }}>
          <div className="h-16" style={{ background: tint }} />
          <div className="flex items-end justify-between gap-2 p-2">
            <div className="min-w-0">
              <p className="text-[11px] font-bold" style={{ color: t.ink }}>{d.name}</p>
              <p className="text-[8px]" style={{ color: t.inkSoft }}>{d.note}</p>
              <p className="mt-0.5 text-[11px] font-extrabold" style={{ color: link }}>{d.price}</p>
            </div>
            {add('px-2.5 py-1')}
          </div>
        </div>
      </div>
    );
  }
  // rows (Classic)
  const d = SAMPLE[0];
  return (
    <div className="px-3">
      <div className="flex gap-2.5 p-2.5" style={{ background: t.card, borderRadius: t.surface, boxShadow: `0 0 0 0.5px ${t.line}` }}>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[12px] font-bold leading-snug" style={{ color: t.ink }}><VegMark />{d.name}</p>
          <p className="mt-0.5 line-clamp-2 text-[9px] leading-snug" style={{ color: t.inkSoft }}>{d.note}</p>
          <p className="mt-1.5 text-[12px] font-extrabold" style={{ color: t.ink }}>
            {d.price} <span className="text-[9px] font-semibold" style={{ color: link }}>Customisable</span>
          </p>
        </div>
        <div className="flex w-16 shrink-0 flex-col items-center">
          <Tile size="4rem" radius="14px" bg={tint} />
          <span className="-mt-3">{add('px-2.5 py-1')}</span>
        </div>
      </div>
    </div>
  );
}

/** What the customer menu will look like in the chosen design, with the chosen colours, drawn from the very same tokens the customer app uses. */
function PhonePreview({ theme, design, restaurant, logo }) {
  const { brand, accent } = buildTheme(theme);
  const style = styleOf(design);
  const t = style.tokens;
  const { vars } = buildStyleVars(design, brand);
  const link = vars['--color-link'];
  const tint = vars['--color-tint'];
  const initial = restaurant.trim().charAt(0).toUpperCase() || 'M';
  const chipOn = { background: brand[600], color: '#fff', borderRadius: t.chip };
  const chipOff = { background: t.fill, color: t.ink, borderRadius: t.chip };
  const underline = style.chips === 'underline';
  const chip = (label, on) =>
    underline ? (
      <span key={label} className="px-1 pb-0.5 text-[10px] font-semibold" style={{ color: on ? t.ink : t.inkSoft, borderBottom: `2px solid ${on ? brand[600] : 'transparent'}` }}>
        {label}
      </span>
    ) : (
      <span key={label} className="px-3 py-1 text-[10px] font-bold" style={on ? chipOn : chipOff}>
        {label}
      </span>
    );
  const dockStyle =
    style.dock === 'flat'
      ? { background: t.card, borderTop: `1px solid ${t.line}` }
      : style.dock === 'float'
        ? { background: t.card, borderRadius: '1.25rem', margin: '0 0.5rem 0.5rem', boxShadow: `0 6px 16px -6px rgb(0 0 0 / 0.35), 0 0 0 0.5px ${t.line}` }
        : { background: t.card, borderRadius: '1rem 1rem 0 0', boxShadow: `0 0 0 0.5px ${t.line}` };

  return (
    <div
      role="img"
      aria-label={`Preview of the customer menu in the ${style.name} design with the chosen colours`}
      className="mx-auto w-[17.5rem] max-w-full overflow-hidden rounded-[2rem] border-[7px] border-slate-900"
      style={{ background: t.page, fontFamily: t.font }}
    >
      <div className="px-3.5 pb-2 pt-4">
        {style.header === 'center' ? (
          <div className="flex flex-col items-center text-center">
            {logo ? (
              <img src={logo} alt="" className="size-8 shrink-0 rounded-[10px] bg-white object-contain p-1" />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center text-sm font-extrabold text-white" style={{ background: brand[700], borderRadius: t.radius.xl }}>{initial}</span>
            )}
            <p className="mt-1.5 max-w-full truncate text-[19px] font-semibold leading-tight" style={{ color: t.ink }}>{restaurant}</p>
            <p className="mt-1 text-[7px] font-semibold uppercase tracking-[0.18em]" style={{ color: t.inkSoft }}>Table T-01 · Pay at counter</p>
            <span className="mt-2 h-px w-10" style={{ background: t.inkSoft, opacity: 0.4 }} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {logo ? (
              <img src={logo} alt="" className="size-8 shrink-0 rounded-[10px] bg-white object-contain p-1" />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center text-sm font-extrabold text-white" style={{ background: brand[700], borderRadius: t.radius.xl }}>{initial}</span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-extrabold leading-tight" style={{ color: t.ink }}>{restaurant}</p>
              <p className="text-[9px] font-semibold" style={{ color: t.inkSoft }}>Pay at counter</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 px-2 py-1 text-[9px] font-bold" style={{ background: t.card, color: t.ink, borderRadius: t.chip, boxShadow: `inset 0 0 0 1px ${t.line}` }}>
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Table T-01
            </span>
          </div>
        )}
        <div className="mt-2.5 px-2.5 py-1.5 text-[10px]" style={{ background: t.fill, color: t.inkSoft, borderRadius: t.radius.lg }}>
          Search dishes
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: t.inverse, color: t.onInverse, borderRadius: t.radius['2xl'] }}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: accent[300] }} />
          <span className="leading-tight">
            <span className="block text-[10px] font-bold">Your order · ₹135</span>
            <span className="block text-[8px] opacity-70">Being prepared</span>
          </span>
        </div>
      </div>

      <div className={`flex gap-1.5 px-3 pb-2 ${underline ? 'justify-center gap-3' : ''}`}>
        {chip('Chef’s picks', true)}
        {chip('Pizza', false)}
        {chip('Starters', false)}
      </div>

      <div className="pb-2">
        <SampleDishes style={style} brand={brand} link={link} tint={tint} />
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center justify-between px-3 py-2" style={{ background: brand[600], color: '#fff', borderRadius: t.radius['2xl'] }}>
          <span className="text-[11px] font-bold">
            View cart <span className="font-medium opacity-75">· 2 items</span>
          </span>
          <span className="text-[12px] font-extrabold">₹998</span>
        </div>
      </div>

      <div className="grid grid-cols-5 pb-2 pt-1.5" style={dockStyle}>
        {Object.entries(TAB_ICONS).map(([label, path]) => (
          <span key={label} className="flex flex-col items-center gap-0.5 text-[7px] font-semibold" style={{ color: label === 'Menu' ? link : t.inkSoft }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
              {path}
            </svg>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A small picture of a design, for the picker: the page, the header and the way dishes are laid out. */
function DesignThumb({ id, brand }) {
  const style = STYLES[id];
  const t = style.tokens;
  const { vars } = buildStyleVars(id, brand);
  const tint = vars['--color-tint'];
  const bar = (w, strong = false) => <span className="block h-1 rounded-full" style={{ width: w, background: strong ? t.ink : t.inkSoft, opacity: strong ? 0.85 : 0.45 }} />;
  const box = (extra) => <span className="block shrink-0" style={{ background: tint, ...extra }} />;
  return (
    <div className="h-[4.75rem] overflow-hidden p-2" style={{ background: t.page, fontFamily: t.font, borderRadius: '0.5rem' }}>
      <div className="mb-1.5 flex items-center gap-1.5" style={{ justifyContent: style.header === 'center' ? 'center' : 'flex-start' }}>
        {box({ width: 8, height: 8, borderRadius: t.radius.md, background: brand[700] })}
        {bar('2.2rem', true)}
      </div>
      {style.list === 'rows' && (
        <div className="flex items-center justify-between gap-2 p-1.5" style={{ background: t.card, borderRadius: t.radius.xl, boxShadow: `0 0 0 0.5px ${t.line}` }}>
          <div className="space-y-1">{bar('2.6rem', true)}{bar('3.4rem')}</div>
          {box({ width: 22, height: 22, borderRadius: t.radius.xl })}
        </div>
      )}
      {style.list === 'menu' && (
        <div className="space-y-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-1" style={{ borderBottom: `1px solid ${t.line}`, paddingBottom: 3 }}>
              {bar('1.8rem', true)}
              <span className="flex-1 border-b border-dotted" style={{ borderColor: t.inkSoft }} />
              {bar('0.7rem', true)}
            </div>
          ))}
        </div>
      )}
      {style.list === 'grid' && (
        <div className="grid grid-cols-2 gap-1.5">
          {[0, 1].map((i) => (
            <div key={i}>
              {box({ width: '100%', height: 28, borderRadius: t.radius['2xl'] })}
              <div className="mt-1">{bar('1.6rem', true)}</div>
            </div>
          ))}
        </div>
      )}
      {style.list === 'compact' && (
        <div style={{ borderTop: `2px solid ${t.ink}` }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-1" style={{ borderBottom: `1px solid ${t.line}` }}>
              {bar('2.4rem', true)}
              <span className="size-2.5" style={{ boxShadow: `inset 0 0 0 1px ${t.inkSoft}`, borderRadius: t.chip }} />
            </div>
          ))}
        </div>
      )}
      {style.list === 'stack' && (
        <div className="overflow-hidden" style={{ background: t.card, borderRadius: t.radius.xl }}>
          {box({ width: '100%', height: 26 })}
          <div className="space-y-1 p-1.5">{bar('2.6rem', true)}{bar('1.2rem')}</div>
        </div>
      )}
    </div>
  );
}

export default function Appearance() {
  useDocumentTitle('Appearance');
  const { vendor, updateVendor } = useAuth();
  const toast = useToast();
  const [run, saving] = useAction();

  const saved = vendor.theme ?? DEFAULT_THEME;
  const [primary, setPrimary] = useState(saved.primary);
  const [accent, setAccent] = useState(saved.accent);
  const savedDesign = saved.style ?? DEFAULT_STYLE;
  const [design, setDesign] = useState(savedDesign);

  const dirty = !same(primary, saved.primary) || !same(accent, saved.accent) || design !== savedDesign;
  const isDefault = same(primary, DEFAULT_THEME.primary) && same(accent, DEFAULT_THEME.accent) && design === DEFAULT_STYLE;
  const { primaryAdjusted } = buildTheme({ primary, accent });

  const save = () =>
    run(async () => {
      try {
        const updated = await api('/api/admin/vendor', { method: 'PATCH', body: { theme_primary: primary, theme_accent: accent, theme_style: design } });
        updateVendor(updated);
        toast.success('Saved. Your customer menu now uses this design and these colours.');
      } catch (error) {
        toast.error(error.message || 'Could not save.');
      }
    });

  return (
    <div className="@container">
      <PageHeader title="Appearance" description="Choose how your customer menu looks and add your logo and colours. Diners see it on your menu, cart and order pages." />

      <div className="grid grid-cols-1 gap-3 @xl:gap-4 @4xl:grid-cols-[minmax(0,1fr)_21rem] @4xl:items-start">
        <div className="min-w-0 space-y-3 @xl:space-y-4">
          <LogoCard />

          <Card as="section" aria-labelledby="design">
            <CardHeader id="design" title="Design" description="Five different looks for your customer menu. Your colours work with every one." />
            <div className="grid grid-cols-2 gap-3 p-4 @xl:grid-cols-3 sm:p-5">
              {STYLE_IDS.map((id) => {
                const active = design === id;
                const brand = buildTheme({ primary, accent }).brand;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDesign(id)}
                    className={cx(
                      'rounded-xl border p-2 text-left transition-colors',
                      active ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-black/[0.08] bg-white hover:bg-slate-50',
                    )}
                  >
                    <DesignThumb id={id} brand={brand} />
                    <span className="mt-2 block px-1 text-sm font-semibold text-slate-900">{STYLES[id].name}</span>
                    <span className="block px-1 pb-1 text-xs leading-snug text-slate-500">{STYLES[id].blurb}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card as="section" aria-labelledby="presets">
            <CardHeader id="presets" title="Ready-made themes" description="Pick one to start with, then fine-tune it below if you like." />
            <div className="grid grid-cols-2 gap-3 p-4 @xl:grid-cols-4 sm:p-5">
              {PRESETS.map((p) => {
                const active = same(p.primary, primary) && same(p.accent, accent);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setPrimary(p.primary);
                      setAccent(p.accent);
                    }}
                    className={cx(
                      'rounded-xl border p-3 text-left transition-colors',
                      active ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-black/[0.08] bg-white hover:bg-slate-50',
                    )}
                  >
                    <span className="flex items-center">
                      <span className="size-7 rounded-full ring-2 ring-white" style={{ background: p.primary }} />
                      <span className="-ml-2 size-7 rounded-full ring-2 ring-white" style={{ background: p.accent }} />
                    </span>
                    <span className="mt-2 block text-sm font-semibold text-slate-900">{p.name}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card as="section" aria-labelledby="custom">
            <CardHeader id="custom" title="Your own colours" description="Use your logo or signboard colours." />
            <div className="grid gap-5 p-4 @xl:grid-cols-2 sm:p-5">
              <ColourField
                id="colour-primary"
                label="Main colour"
                hint="Header, buttons, prices and highlights."
                value={primary}
                onChange={setPrimary}
              />
              <ColourField
                id="colour-accent"
                label="Accent colour"
                hint="Small touches, like the dot on the “Your order” bar."
                value={accent}
                onChange={setAccent}
              />
            </div>
            {primaryAdjusted && (
              <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                <Alert tone="info">
                  That main colour is quite light, so buttons use a slightly darker version of it. This keeps the white text on them easy to read.
                </Alert>
              </div>
            )}
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {dirty && <span className="text-sm text-slate-500">You have unsaved changes.</span>}
            {!isDefault && (
              <Button
                variant="secondary"
                onClick={() => {
                  setPrimary(DEFAULT_THEME.primary);
                  setAccent(DEFAULT_THEME.accent);
                  setDesign(DEFAULT_STYLE);
                }}
              >
                Reset to default
              </Button>
            )}
            <Button size="lg" busy={saving} disabled={!dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        <Card as="aside" aria-labelledby="preview" className="@4xl:sticky @4xl:top-20">
          <CardHeader id="preview" title="Preview" description="Updates as you choose." />
          <div className="rounded-b-2xl bg-slate-50 p-5">
            <PhonePreview theme={{ primary, accent }} design={design} restaurant={vendor.name} logo={vendor.logo_url ? apiUrl(vendor.logo_url) : null} />
          </div>
        </Card>
      </div>
    </div>
  );
}
