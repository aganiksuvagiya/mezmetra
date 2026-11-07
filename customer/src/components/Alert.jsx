import { AlertIcon, CheckIcon, InfoIcon } from './Icons';

const tones = {
  error: { box: 'bg-rose-50 text-rose-900 ring-rose-200', icon: AlertIcon, iconClass: 'text-rose-700' },
  warning: { box: 'bg-amber-50 text-amber-950 ring-amber-200', icon: AlertIcon, iconClass: 'text-amber-700' },
  info: { box: 'bg-brand-50 text-brand-900 ring-brand-200', icon: InfoIcon, iconClass: 'text-brand-700' },
  success: { box: 'bg-emerald-50 text-emerald-900 ring-emerald-200', icon: CheckIcon, iconClass: 'text-emerald-700' },
};

/** Inline message. Errors are announced immediately (role=alert); everything else politely (role=status). */
export default function Alert({ tone = 'error', title, children, className = '' }) {
  const { box, icon: Icon, iconClass } = tones[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex gap-3 rounded-2xl px-4 py-3 text-sm ring-1 ring-inset ${box} ${className}`}
    >
      <Icon className={`mt-0.5 size-5 shrink-0 ${iconClass}`} />
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="font-bold">{title}</p>}
        {children}
      </div>
    </div>
  );
}
