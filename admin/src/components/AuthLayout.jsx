import { CheckCircleIcon, LogoMark } from './icons.jsx';

const POINTS = [
  'Diners scan a QR code at the table and order from their phone',
  'Accept orders, take cash or online payments, print receipts',
  'See today’s revenue and your best sellers at a glance',
];

/** A static sample of what a restaurant sees, so the sign-in page shows the product instead of a decoration. */
function SampleOrder() {
  return (
    <div aria-hidden="true" className="max-w-sm rounded-2xl bg-white p-4 text-slate-900">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold">
          #12 <span className="font-normal text-slate-500">· Table T-04</span>
        </p>
        <span className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700">Preparing</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">2× Masala Chai, 1× Bun Maska</p>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
        <span className="font-semibold tabular-nums">₹135</span>
        <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Paid · Online</span>
      </div>
    </div>
  );
}

/**
 * The frame shared by sign in and the password reset pages: a flat brand panel on the left (wide screens only) and the form in a
 * white card on the right, both floating on the same light grey as the rest of the admin.
 */
export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="min-h-dvh bg-[#eeeef0] p-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-3">
      <aside className="hidden rounded-2xl bg-brand-700 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <span className="text-xl font-bold tracking-tight">MezMitra</span>
        </div>
        <div>
          <h2 className="max-w-md text-4xl font-bold leading-tight tracking-tight">Table ordering that runs itself.</h2>
          <ul className="mt-8 max-w-md space-y-4 text-brand-50">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <CheckCircleIcon size={22} className="mt-0.5 shrink-0 text-brand-200" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="mt-10">
            <SampleOrder />
          </div>
        </div>
        <p className="text-sm text-brand-100">Back-office for restaurants</p>
      </aside>

      <main className="flex min-h-[calc(100dvh-1.5rem)] items-center justify-center py-6 lg:min-h-0 lg:py-0">
        <div className="w-full max-w-md rounded-2xl border border-black/[0.05] bg-white p-6 sm:p-8">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
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
