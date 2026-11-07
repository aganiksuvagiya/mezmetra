import { useId, useRef } from 'react';
import { cx } from '../lib/cx.js';

/**
 * Accessible tab list (roving tabindex, arrow keys). Render the panel yourself with
 * `role="tabpanel" id={panelId(tabsId, value)} aria-labelledby={tabId(tabsId, value)}`; see Orders for the pattern.
 */
export const tabId = (base, value) => `${base}-tab-${value}`;
export const panelId = (base, value) => `${base}-panel-${value}`;

export function Tabs({ idBase, label, tabs, value, onChange, className }) {
  const autoId = useId();
  const base = idBase ?? autoId;
  const refs = useRef({});

  const onKeyDown = (e) => {
    const index = tabs.findIndex((t) => t.value === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].value);
    refs.current[tabs[next].value]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xs', className)}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[t.value] = el;
            }}
            type="button"
            role="tab"
            id={tabId(base, t.value)}
            aria-selected={selected}
            aria-controls={panelId(base, t.value)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cx(
              'inline-flex h-9 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors focus-visible:-outline-offset-2',
              selected ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
            )}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className={cx('min-w-5 rounded-full px-1.5 py-px text-center text-xs font-semibold', selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600')}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
