import { useEffect, useId, useRef } from 'react';
import { cx } from '../lib/cx.js';
import { CloseIcon } from './icons.jsx';

/**
 * A detail panel docked against the right edge of the screen, full height. The page shrinks to make room for it (see
 * SidePanelContext) instead of the panel floating over it, so the list stays visible and clickable, and the panel stays put while the
 * page scrolls. Put it in a box that is fixed to the right edge (the page does). Same props as <Modal> (title, footer, children, onClose).
 * Esc closes it (unless a dialog is open on top of it), and focus goes in on open and back to what opened it on close.
 * Use it only when there is room (a wide screen); on a phone use <Modal variant="drawer"> instead.
 */
export default function SidePanel({ title, onClose, children, footer, className }) {
  const panelRef = useRef(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement;
    panel.focus({ preventScroll: true });
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return; // a confirm dialog is on top: Esc belongs to it
      onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <section
      ref={panelRef}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={cx(
        'flex h-full min-h-0 animate-slide-in flex-col overflow-hidden border-l border-slate-200 bg-white shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.18)] outline-none',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
        <h2 id={titleId} className="text-lg font-semibold leading-snug text-slate-900">
          {title}
        </h2>
        <button
          type="button"
          onClick={() => onClose?.()}
          aria-label="Close panel"
          className="-mr-1.5 -mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          <CloseIcon size={20} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3">{footer}</div>}
    </section>
  );
}
