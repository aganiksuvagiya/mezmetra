import { useState } from 'react';
import { buildTheme, DEFAULT_THEME, HEX_RE } from '../../../shared/theme.js';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
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
          className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
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
            'h-10 w-32 rounded-lg border bg-white px-3 font-mono text-sm uppercase text-slate-900',
            invalid ? 'border-red-400 ring-1 ring-red-300' : 'border-slate-300',
          )}
        />
      </div>
      <p id={`${id}-hint`} className={cx('mt-1.5 text-xs', invalid ? 'text-red-700' : 'text-slate-500')}>
        {invalid ? 'Use a colour like #2f6f62 (a # and six letters or digits).' : hint}
      </p>
    </div>
  );
}

/** What the customer menu will look like, drawn with the very same shades the customer app generates. */
function PhonePreview({ theme, restaurant }) {
  const { brand, accent } = buildTheme(theme);
  return (
    <div
      role="img"
      aria-label="Preview of the customer menu with the chosen colours"
      className="mx-auto w-[17.5rem] overflow-hidden rounded-[2rem] border-[7px] border-slate-900 bg-[#f6f4ee] shadow-lg"
    >
      <div
        className="rounded-b-[1.4rem] px-4 pb-9 pt-5 text-white"
        style={{ background: `linear-gradient(135deg, ${brand[800]}, ${brand[700]} 55%, ${brand[600]})` }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-[0.18em]" style={{ color: brand[100] }}>
              Welcome to
            </p>
            <p className="truncate text-lg font-extrabold leading-tight">{restaurant}</p>
          </div>
          <div className="rounded-xl px-2.5 py-1 text-center" style={{ background: 'rgb(255 255 255 / 0.15)' }}>
            <p className="text-[8px] font-bold uppercase tracking-wider" style={{ color: brand[100] }}>
              Table
            </p>
            <p className="text-sm font-extrabold leading-none">T-01</p>
          </div>
        </div>
      </div>

      <div className="-mt-4 px-3">
        <div className="rounded-xl bg-white px-3 py-2 text-[11px] text-slate-400 shadow">Search dishes</div>
      </div>

      <div className="flex gap-1.5 px-3 pb-2 pt-3">
        <span className="rounded-full px-3 py-1 text-[10px] font-bold text-white" style={{ background: brand[700] }}>
          Chef’s picks
        </span>
        <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-slate-800 ring-1 ring-slate-200">Pizza</span>
        <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold text-slate-800 ring-1 ring-slate-200">Starters</span>
      </div>

      <div className="space-y-2.5 px-3 pb-3">
        <div className="flex gap-2.5 rounded-2xl bg-white p-2.5 shadow">
          <div className="min-w-0 flex-1">
            <span
              className="inline-block rounded-full px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wide"
              style={{ background: accent[100], color: accent[700] }}
            >
              Chef’s pick
            </span>
            <p className="mt-0.5 text-[13px] font-extrabold leading-snug text-slate-900">Margherita Pizza</p>
            <p className="line-clamp-2 text-[10px] leading-snug text-slate-500">Fresh mozzarella and basil on a crispy crust.</p>
            <p className="mt-1.5 text-[13px] font-extrabold" style={{ color: brand[800] }}>
              ₹499
            </p>
          </div>
          <div className="flex w-16 shrink-0 flex-col items-center">
            <div className="size-16 rounded-xl" style={{ background: `linear-gradient(145deg, ${brand[100]}, ${brand[200]})` }} />
            <span
              className="-mt-3 rounded-lg bg-white px-2.5 py-1 text-[10px] font-extrabold uppercase shadow ring-1 ring-inset"
              style={{ color: brand[700], '--tw-ring-color': brand[200] }}
            >
              Add +
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl px-2.5 py-2 text-white shadow-md" style={{ background: brand[700] }}>
          <span className="flex items-center gap-2">
            <span className="relative grid size-7 place-items-center rounded-lg text-[10px]" style={{ background: 'rgb(255 255 255 / 0.15)' }}>
              🛍
              <span
                className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full text-[8px] font-extrabold text-slate-900"
                style={{ background: accent[300] }}
              >
                2
              </span>
            </span>
            <span className="leading-tight">
              <span className="block text-[12px] font-extrabold">₹998</span>
              <span className="block text-[9px] font-semibold" style={{ color: brand[100] }}>
                2 items
              </span>
            </span>
          </span>
          <span className="text-[11px] font-extrabold">View cart ›</span>
        </div>
      </div>
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

  const dirty = !same(primary, saved.primary) || !same(accent, saved.accent);
  const isDefault = same(primary, DEFAULT_THEME.primary) && same(accent, DEFAULT_THEME.accent);
  const { primaryAdjusted } = buildTheme({ primary, accent });

  const save = () =>
    run(async () => {
      try {
        const updated = await api('/api/admin/vendor', { method: 'PATCH', body: { theme_primary: primary, theme_accent: accent } });
        updateVendor(updated);
        toast.success('Colours saved. Your customer menu now uses them.');
      } catch (error) {
        toast.error(error.message || 'Could not save the colours.');
      }
    });

  return (
    <>
      <PageHeader title="Appearance" description="Choose the colours diners see on your menu, cart and order pages." />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-6">
        <div className="space-y-4 sm:space-y-6">
          <Card as="section" aria-labelledby="presets">
            <CardHeader id="presets" title="Ready-made themes" description="Pick one to start with, then fine-tune it below if you like." />
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5">
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
                      active ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50',
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
            <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
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
                hint="Small touches like the Chef’s pick badge."
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
                }}
              >
                Reset to default
              </Button>
            )}
            <Button size="lg" busy={saving} disabled={!dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save colours'}
            </Button>
          </div>
        </div>

        <Card as="aside" aria-labelledby="preview" className="lg:sticky lg:top-20">
          <CardHeader id="preview" title="Preview" description="Updates as you choose." />
          <div className="bg-slate-50 p-5">
            <PhonePreview theme={{ primary, accent }} restaurant={vendor.name} />
          </div>
        </Card>
      </div>
    </>
  );
}
