import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './Icons';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isVisible = (el) => el.getClientRects().length > 0;

/**
 * Modal bottom sheet. role=dialog + aria-modal, labelled by the heading the caller renders with id `labelledBy`.
 * Esc and a tap on the backdrop close it; Tab is trapped inside; focus moves into the sheet when it opens and
 * returns to whatever opened it when it closes; the page behind does not scroll.
 *
 * `children` scrolls; `footer` stays pinned (with safe-area padding) at the bottom.
 */
export default function BottomSheet({ onClose, labelledBy, children, footer }) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement;

    const { overflow, paddingRight } = document.body.style;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    panel.focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(isVisible);
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active) || active === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[3px] motion-safe:animate-fade-in" onClick={() => onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="relative flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[32px] bg-white shadow-sheet focus:outline-none motion-safe:animate-sheet-in"
      >
        <button
          type="button"
          onClick={() => onClose()}
          aria-label="Close"
          className="glass absolute right-3 top-3 z-10 grid size-11 place-items-center rounded-full text-ink shadow-float hover:bg-white"
        >
          <CloseIcon />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="border-t border-line bg-white px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
