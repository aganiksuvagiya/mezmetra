/** Centered message block used for empty cart, invalid QR code, errors, unknown orders... */
export default function EmptyState({ icon, title, children, action, tone = 'neutral', as: Heading = 'h1', className = '' }) {
  const badge = tone === 'danger' ? 'bg-rose-100 text-rose-700' : 'bg-brand-100 text-brand-700';
  return (
    <div className={`flex flex-col items-center px-6 py-14 text-center ${className}`}>
      {icon && <div className={`mb-5 grid size-16 place-items-center rounded-3xl ${badge}`}>{icon}</div>}
      <Heading className="max-w-full text-xl font-extrabold leading-snug text-ink [overflow-wrap:anywhere]">{title}</Heading>
      {children && <div className="mt-2 max-w-xs text-base text-ink-soft [overflow-wrap:anywhere]">{children}</div>}
      {action && <div className="mt-6 flex w-full max-w-xs flex-col gap-2">{action}</div>}
    </div>
  );
}
