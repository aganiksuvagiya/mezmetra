import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { PrinterIcon, QrIcon } from '../components/icons.jsx';
import QrCard from '../components/QrCard.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { useDocumentTitle, useQuery } from '../lib/hooks.js';

export default function QrCodes() {
  useDocumentTitle('QR codes');
  const { vendor } = useAuth();
  const q = useQuery(() => api('/api/admin/tables'), []);
  const [settled, setSettled] = useState(() => new Set());
  const onSettled = useCallback((id) => setSettled((s) => (s.has(id) ? s : new Set(s).add(id))), []);

  const tables = q.data;
  const printable = (tables ?? []).filter((t) => t.is_active);
  const ready = printable.every((t) => settled.has(t.id));

  return (
    <>
      <PageHeader
        title="QR codes"
        description="Print these and place one on each table. Diners scan to see the menu and order."
        actions={
          <Button icon={PrinterIcon} disabled={!tables || printable.length === 0 || !ready} onClick={() => window.print()}>
            {tables && printable.length > 0 && !ready ? 'Preparing…' : 'Print all'}
          </Button>
        }
      />

      {q.loading && (
        <div role="status" aria-label="Loading QR codes" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      )}
      {!q.loading && !tables && (
        <Card>
          <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load your tables" />
        </Card>
      )}

      {tables && tables.length === 0 && (
        <Card>
          <EmptyState
            icon={QrIcon}
            title="No tables yet"
            message="Add your tables first and each one gets its own QR code."
            action={
              <Link to="/tables" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
                Add tables
              </Link>
            }
          />
        </Card>
      )}

      {tables && tables.length > 0 && (
        <>
          {tables.some((t) => !t.is_active) && (
            <Alert tone="info" className="mb-4 print:hidden">
              Tables that are switched off are shown here but left out when you print, because their QR codes don&rsquo;t take orders.
            </Alert>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2 print:gap-6">
            {tables.map((t) => (
              <QrCard key={t.id} table={t} restaurantName={vendor?.name} onSettled={onSettled} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
