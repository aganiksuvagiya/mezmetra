import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.js';
import { CloseIcon } from './icons.jsx';

// Open modals, top-most last: only the top one reacts to Esc/Tab (a confirm dialog can sit on top of a detail modal).
const stack = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const sizes = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-3xl',
};

// A drawer is narrower than the same-named dialog: it only takes a side of the screen.
const drawerSizes = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-xl',
  xl: 'sm:max-w-2xl',
};

/**
 * Accessible modal dialog: role/aria-modal/labelled title, focus moves in on open, Tab is trapped, Esc and a backdrop
 * click close it, and focus returns to whatever opened it. Mount it only while it should be open (so form state resets).
 * Pass `onSubmit` to render the panel as a <form> (put the submit button in `footer` with type="submit").
 * Set `dismissible={false}` while a request is running to block Esc/backdrop closing.
 * `variant="drawer"` shows the same dialog as a panel that slides in from the right (full screen on a phone) and slides out again
 * when it is closed with Esc, the backdrop or the close button.
 */
export default function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  variant = 'modal',
  role = 'dialog',
  dismissible = true,
  onSubmit,
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const drawer = variant === 'drawer';
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const leaveTimer = useRef(null);

  // Closing from inside (Esc, backdrop, the X): a drawer plays its slide-out first, unless the person asked for less motion.
  const requestClose = () => {
    if (leavingRef.current) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!drawer || calm) {
      onCloseRef.current?.();
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => onCloseRef.current?.(), 170);
  };
  const requestCloseRef = useRef(requestClose);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    requestCloseRef.current = requestClose;
  });

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    const token = {};
    stack.push(token);
    const panel = panelRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const initial = panel.querySelector('[data-autofocus]') ?? panel.querySelector('[data-modal-body]')?.querySelector(FOCUSABLE) ?? panel;
    initial.focus({ preventScroll: true });

    const onKeyDown = (e) => {
      if (stack[stack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        if (dismissibleRef.current) {
          e.preventDefault();
          requestCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      stack.splice(stack.indexOf(token), 1);
      document.body.style.overflow = previousOverflow;
      // Give focus back to the control that opened the dialog; if that control is gone (deleted row) fall back to <main>.
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
      else document.getElementById('main-content')?.focus({ preventScroll: true });
    };
  }, []);

  const Wrapper = onSubmit ? 'form' : 'div';
  const wrapperProps = onSubmit ? { onSubmit, noValidate: true } : {};

  return createPortal(
    <div className={cx('fixed inset-0 z-50 flex', drawer ? 'justify-end' : 'items-end justify-center sm:items-center sm:p-4')}>
      <div
        aria-hidden="true"
        className={cx('absolute inset-0 bg-slate-900/50', leaving ? 'opacity-0 transition-opacity duration-150' : 'animate-fade-in')}
        onMouseDown={() => dismissibleRef.current && requestCloseRef.current()}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'relative flex w-full flex-col overflow-hidden bg-white shadow-2xl outline-none',
          drawer
            ? cx('h-dvh sm:rounded-l-2xl', leaving ? 'animate-slide-out' : 'animate-slide-in', drawerSizes[size])
            : cx('max-h-[92dvh] animate-pop-in rounded-t-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl', sizes[size]),
        )}
      >
        <Wrapper {...wrapperProps} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <h2 id={titleId} className="text-lg font-semibold leading-snug text-slate-900">
              {title}
            </h2>
            <button
              type="button"
              onClick={() => requestClose()}
              disabled={!dismissible}
              aria-label={drawer ? 'Close panel' : 'Close dialog'}
              className="-mr-2 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
            >
              <CloseIcon size={20} />
            </button>
          </div>
          <div data-modal-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {description && (
              <div id={descId} className="mb-4 text-sm text-slate-600">
                {description}
              </div>
            )}
            {children}
          </div>
          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">{footer}</div>
          )}
        </Wrapper>
      </div>
    </div>,
    document.body,
  );
}
