import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/cx.js';
import { AlertIcon, CheckCircleIcon, CloseIcon, InfoIcon } from './icons.jsx';

const ToastContext = createContext(null);

export const useToast = () => useContext(ToastContext);

const styles = {
  success: ['border-emerald-200 bg-white', 'text-emerald-600', CheckCircleIcon],
  error: ['border-red-200 bg-white', 'text-red-600', AlertIcon],
  info: ['border-slate-200 bg-white', 'text-sky-600', InfoIcon],
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone, message) => {
      const id = ++nextId.current;
      setToasts((list) => [...list.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext value={api}>
      {children}
      {/* The live region stays mounted (even when empty) so screen readers announce what appears in it. */}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 print:hidden sm:inset-x-auto sm:right-4 sm:items-end"
      >
        {toasts.map((t) => {
          const [box, iconColor, Icon] = styles[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cx('pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-xl border px-4 py-3 text-sm text-slate-800 shadow-lg', box)}
            >
              <Icon size={18} className={cx('mt-0.5', iconColor)} />
              <p className="min-w-0 flex-1 break-words">{t.message}</p>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="-mr-1 -mt-0.5 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <CloseIcon size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext>
  );
}
