import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from './Card.jsx';
import { Alert } from './EmptyState.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

const MODES = [
  {
    value: 'off',
    title: 'Off',
    text: 'Diners just scan and order. Anyone who has your QR link could order from home.',
    saved: 'Diners are no longer asked for a table code.',
  },
  {
    value: 'optional',
    title: 'Optional',
    text: 'Diners may type the code. A wrong code is refused; leaving it empty is fine. Orders with the right code are marked "Code verified" so you can trust them first.',
    saved: 'Diners can now type the table code if they want. Print your QR cards again so they show it.',
  },
  {
    value: 'required',
    title: 'Required',
    text: 'An order is only taken when the diner types the 4-digit code printed on their table. Stops orders from people who are not at your table.',
    saved: 'Diners must now enter the table code. Print your QR cards again so they show it.',
  },
];

/** How strictly diners are asked for the table code (the fake-order guard). It saves straight away, like the logo. */
export default function TableCodeCard() {
  const { vendor, updateVendor } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mode = vendor.table_code_mode ?? 'off';

  const change = async (next) => {
    if (next === mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      updateVendor(await api('/api/admin/vendor', { method: 'PATCH', body: { table_code_mode: next } }));
      toast.success(MODES.find((m) => m.value === next).saved);
    } catch (err) {
      setError(err.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="table-code">
      <CardHeader id="table-code" title="Table code" description="Each table has its own 4-digit code printed on its QR card. Choose whether diners must type it." />
      <div className="space-y-4 p-4 sm:p-5">
        {error && <Alert>{error}</Alert>}
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <legend className="sr-only">Ask diners for the table code</legend>
          {MODES.map((m) => (
            <label
              key={m.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 transition-colors has-checked:border-brand-500 has-checked:bg-brand-50 has-focus-visible:ring-2 has-focus-visible:ring-brand-500 has-focus-visible:ring-offset-1 has-disabled:cursor-wait has-disabled:opacity-70"
            >
              <input
                type="radio"
                name="table-code-mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => change(m.value)}
                className="mt-0.5 size-4 shrink-0 accent-brand-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">{m.title}</span>
                <span className="mt-0.5 block text-xs text-slate-600">{m.text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode !== 'off' && (
          <p className="text-sm text-slate-600">
            The code is printed on each table&rsquo;s card. <Link to="/tables/qr" className="font-medium text-brand-700 underline underline-offset-2">Print the cards again</Link>, and use <strong>New code</strong> in a table&rsquo;s QR window if a code gets shared.
          </p>
        )}
      </div>
    </Card>
  );
}
