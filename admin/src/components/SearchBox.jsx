import { useEffect, useRef } from 'react';
import { cx } from '../lib/cx.js';
import { SearchIcon } from './icons.jsx';

/** The search field used at the top of every list: a white rounded box, and ⌘K / Ctrl+K jumps to it (one per page). */
export default function SearchBox({ value, onChange, placeholder, label, maxLength = 60, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <label className={cx('flex h-11 w-full items-center gap-2 rounded-xl border border-black/[0.05] bg-white px-3 focus-within:border-brand-500', className)}>
      <SearchIcon size={18} className="shrink-0 text-slate-400" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
      />
      <kbd className="hidden rounded-md border border-black/10 px-1.5 py-0.5 font-sans text-xs text-slate-400 sm:block">⌘K</kbd>
    </label>
  );
}
