import { cx } from '../lib/cx.js';

export function Card({ as: Tag = 'div', className = '', children, ...rest }) {
  return (
    <Tag className={cx('rounded-xl border border-slate-200 bg-white shadow-xs', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, actions, id, className = '' }) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5', className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3 sm:mb-6 print:hidden">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
