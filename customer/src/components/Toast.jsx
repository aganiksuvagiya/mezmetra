import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './Icons';

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const toneStyles = {
  info: { box: 'bg-brand-900 text-white', icon: InfoIcon },
  success: { box: 'bg-brand-800 text-white', icon: CheckIcon },
  error: { box: 'bg-rose-800 text-white', icon: AlertIcon },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message, { tone = 'info', action, duration } = {}) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((list) => [...list.slice(-2), { id, message, tone, action }]);
      const ms = duration ?? (tone === 'error' ? 7000 : action ? 6000 : 3500);
      window.setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      show,
      dismiss,
      info: (message, opts) => show(message, { ...opts, tone: 'info' }),
      success: (message, opts) => show(message, { ...opts, tone: 'success' }),
      error: (message, opts) => show(message, { ...opts, tone: 'error' }),
    }),
    [show, dismiss],
  );

  const renderToast = (t) => {
    const { box, icon: Icon } = toneStyles[t.tone] ?? toneStyles.info;
    return (
      <div
        key={t.id}
        className={`pointer-events-auto flex items-center gap-3 rounded-[18px] py-2 pl-4 pr-2 text-sm font-medium shadow-float motion-safe:animate-toast-in ${box}`}
      >
        <Icon className="size-5 shrink-0" />
        <p className="min-w-0 flex-1 break-words py-1">{t.message}</p>
        {t.action && (
          <button
            type="button"
            onClick={() => {
              t.action.onClick();
              dismiss(t.id);
            }}
            className="focus-on-dark min-h-11 shrink-0 rounded-xl px-3 font-bold underline underline-offset-2 hover:bg-white/10"
          >
            {t.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => dismiss(t.id)}
          aria-label="Dismiss notification"
          className="focus-on-dark grid size-11 shrink-0 place-items-center rounded-xl hover:bg-white/10"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
    );
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Two always-mounted live regions: errors interrupt, everything else waits its turn. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+0.25rem)] z-[70] px-4">
        <div className="mx-auto flex max-w-md flex-col gap-2">
          <div role="status" aria-live="polite" className="flex flex-col gap-2">
            {toasts.filter((t) => t.tone !== 'error').map(renderToast)}
          </div>
          <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
            {toasts.filter((t) => t.tone === 'error').map(renderToast)}
          </div>
        </div>
      </div>
    </ToastContext.Provider>
  );
}
