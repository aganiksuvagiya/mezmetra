import { CheckCircleIcon, LogoMark } from './icons.jsx';

const POINTS = [
  'Diners scan a QR code at the table and order from their phone',
  'Accept orders, take UPI payments, print receipts',
  'See today’s revenue and your best sellers at a glance',
];

/** The two-column frame shared by sign in, sign up and the password reset pages: brand panel on the left, the form on the right. */
export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <span className="text-xl font-bold tracking-tight">MezMitra</span>
        </div>
        <div>
          <h2 className="max-w-md text-4xl font-bold leading-tight tracking-tight">Table ordering that runs itself.</h2>
          <ul className="mt-8 max-w-md space-y-4 text-brand-50">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <CheckCircleIcon size={22} className="mt-0.5 text-brand-200" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-brand-100">Back-office for restaurants</p>
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-24 size-80 rounded-full bg-white/5" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 top-24 size-40 rounded-full bg-white/5" />
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <LogoMark size={36} />
            <span className="text-xl font-bold tracking-tight text-slate-900">
              Mez<span className="text-brand-600">Mitra</span>
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
