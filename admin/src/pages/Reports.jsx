import { useState } from 'react';
import { Badge } from '../components/Badge.jsx';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert, ErrorState } from '../components/EmptyState.jsx';
import { Input } from '../components/Field.jsx';
import { DownloadIcon } from '../components/icons.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, apiBlob } from '../lib/api.js';
import { formatNumber } from '../lib/format.js';
import { downloadUrl, useAction, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';

const MAX_DAYS = 92;
const METHOD_LABEL = { upi: 'UPI apps', cash: 'Cash', razorpay: 'Online (Razorpay)', cashfree: 'Online (Cashfree)' };
const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
];

// Dates here are plain "YYYY-MM-DD" strings in the restaurant's own time zone, the same ones the API works with.
const todayIn = (timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 + 1;
const rangeFor = (preset, today) => {
  if (preset === 'yesterday') return [addDays(today, -1), addDays(today, -1)];
  if (preset === 'week') return [addDays(today, -6), today];
  if (preset === 'month') return [`${today.slice(0, 8)}01`, today];
  return [today, today];
};
const prettyDay = (ymd) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));

function Stat({ title, value, note, children }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-sm text-slate-500">{note}</p>}
      {children}
    </Card>
  );
}

export default function Reports() {
  useDocumentTitle('Reports');
  const { vendor } = useAuth();
  const fmt = useFmt();
  const toast = useToast();
  const [save, saving] = useAction();

  const today = todayIn(vendor?.timezone || 'Asia/Kolkata');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const days = from && to ? daysBetween(from, to) : 0;
  const problem = !from || !to ? 'Choose both dates.' : days < 1 ? 'The end date is before the start date.' : days > MAX_DAYS ? `Choose at most ${MAX_DAYS} days at a time.` : null;
  const q = useQuery(() => api('/api/admin/reports/summary', { query: { from, to } }), [from, to], { enabled: !problem });

  const activePreset = PRESETS.find(([key]) => {
    const [a, b] = rangeFor(key, today);
    return a === from && b === to;
  })?.[0];

  const download = (kind) =>
    save(async () => {
      const suffix = from === to ? from : `${from}_to_${to}`;
      const [path, name] = kind === 'csv' ? ['orders.csv', `orders-${suffix}.csv`] : ['report.pdf', `sales-report-${suffix}.pdf`];
      try {
        const blob = await apiBlob(`/api/admin/reports/${path}`, { query: { from, to } });
        const url = URL.createObjectURL(blob);
        downloadUrl(url, name);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        toast.success(`${name} downloaded.`);
      } catch (error) {
        toast.error(error.message || "Couldn't create the report. Please try again.");
      }
    });

  const d = q.data;
  const hasMoney = d && d.sales.orders > 0;

  return (
    <>
      <PageHeader title="Reports" description="Daily sales for you and your accountant. Download a spreadsheet (CSV) or a PDF." />

      <Card className="mb-4 sm:mb-6">
        <CardHeader title="Period" description="Days are your restaurant’s own calendar days." />
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick periods">
            {PRESETS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={activePreset === key}
                onClick={() => {
                  const [a, b] = rangeFor(key, today);
                  setFrom(a);
                  setTo(b);
                }}
                className={`h-9 rounded-full px-4 text-sm font-medium ring-1 ring-inset ${
                  activePreset === key ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="From" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
            <Input label="To" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          </div>
          {problem && <Alert tone="warning">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button icon={DownloadIcon} disabled={Boolean(problem) || saving} onClick={() => download('csv')}>
              Download spreadsheet (CSV)
            </Button>
            <Button variant="secondary" icon={DownloadIcon} disabled={Boolean(problem) || saving} onClick={() => download('pdf')}>
              Download PDF
            </Button>
          </div>
        </div>
      </Card>

      {!problem && q.loading && (
        <div role="status" aria-label="Loading the report" className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
        </div>
      )}
      {!problem && !q.loading && !d && (
        <Card>
          <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load the report" />
        </Card>
      )}

      {d && (
        <div className="space-y-4 sm:space-y-6">
          <p className="text-sm text-slate-500">{from === to ? prettyDay(from) : `${prettyDay(from)} to ${prettyDay(to)}`}</p>
          <div className="grid gap-4 sm:grid-cols-3 sm:gap-6">
            <Stat title="Money received" value={fmt.money(d.sales.total)} note={`${formatNumber(d.sales.orders)} paid ${d.sales.orders === 1 ? 'order' : 'orders'} · counted on the day it was paid`}>
              {hasMoney && (
                <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-600">
                  {d.sales.by_method
                    .filter((m) => m.orders > 0)
                    .map((m) => (
                      <li key={m.method} className="flex justify-between gap-3">
                        <span>{METHOD_LABEL[m.method] ?? m.method}</span>
                        <span className="font-semibold text-slate-900 tabular-nums">{fmt.money(m.amount)}</span>
                      </li>
                    ))}
                  <li className="flex justify-between gap-3 text-xs text-slate-500">
                    <span>Includes tax</span>
                    <span className="tabular-nums">{fmt.money(d.sales.tax)}</span>
                  </li>
                </ul>
              )}
            </Stat>
            <Stat title="Orders placed" value={formatNumber(d.placed.total)} note="Orders that came in during this period">
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                <Badge tone="green">{d.placed.completed} completed</Badge>
                <Badge tone="blue">{d.placed.open} open</Badge>
                <Badge tone="slate">{d.placed.cancelled} cancelled</Badge>
              </div>
            </Stat>
            <Stat title="Not paid yet" value={fmt.money(d.placed.unpaid_value)} note={`${formatNumber(d.placed.unpaid)} ${d.placed.unpaid === 1 ? 'order' : 'orders'} placed in this period (cancelled ones left out)`} />
          </div>

          <Card>
            <CardHeader title="Best sellers" description="Paid orders in this period." />
            {d.top_items.length === 0 ? (
              <p className="p-4 text-sm text-slate-500 sm:p-5">Nothing sold in this period.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {d.top_items.map((item) => (
                  <li key={item.name} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                    <span className="min-w-0 truncate text-slate-900">
                      <span className="font-semibold tabular-nums">{formatNumber(item.quantity)}</span> × {item.name}
                    </span>
                    <span className="font-semibold text-slate-900 tabular-nums">{fmt.money(item.revenue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
