import { useEffect, useState } from 'react';
import { apiBlob } from '../lib/api.js';
import { slug } from '../lib/format.js';
import { downloadUrl, useBlobUrl } from '../lib/hooks.js';
import { Badge } from './Badge.jsx';
import { Button } from './Button.jsx';
import { DownloadIcon, RefreshIcon } from './icons.jsx';
import { Spinner } from './Spinner.jsx';
import { useToast } from './Toast.jsx';

/**
 * One printable QR card. The image is fetched with the auth header and shown through a blob URL (revoked on unmount).
 * Calls `onSettled(table.id)` once the image has loaded or failed so the page knows when "Print all" is safe.
 */
export default function QrCard({ table, restaurantName, onSettled }) {
  const toast = useToast();
  const qr = useBlobUrl(`/api/admin/tables/${table.id}/qr.png?size=600`);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!qr.loading) onSettled?.(table.id);
  }, [qr.loading, table.id, onSettled]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await apiBlob(`/api/admin/tables/${table.id}/qr.png?size=1024`);
      const url = URL.createObjectURL(blob);
      downloadUrl(url, `table-${slug(table.number)}-qr.png`);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className={`flex flex-col items-center rounded-xl border border-slate-200 bg-white p-4 text-center shadow-xs print:break-inside-avoid print:rounded-none print:border-slate-400 print:p-6 print:shadow-none ${table.is_active ? '' : 'print:hidden'}`}>
      <div className="flex aspect-square w-full max-w-56 items-center justify-center print:max-w-64">
        {qr.loading && (
          <span role="status" className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size={18} /> Loading…
          </span>
        )}
        {qr.url && <img src={qr.url} alt={`QR code for table ${table.number}`} className="size-full" />}
        {qr.error && (
          <div role="alert" className="flex flex-col items-center gap-2 text-sm text-slate-600">
            <p>Couldn&rsquo;t load this code.</p>
            <Button variant="secondary" size="sm" icon={RefreshIcon} onClick={qr.retry}>
              Retry
            </Button>
          </div>
        )}
      </div>

      <p className="mt-3 hidden text-sm font-medium uppercase tracking-wider text-slate-500 print:block">Scan to order · {restaurantName}</p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 print:text-5xl">{table.number}</h2>
      <p className="mt-0.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-slate-500 print:hidden">
        {table.area} · {table.capacity} seats
        {!table.is_active && <Badge tone="slate">Switched off</Badge>}
      </p>
      <p className="mt-2 w-full break-all text-[11px] leading-snug text-slate-400 print:text-slate-600" title={table.qr_url}>
        {table.qr_url}
      </p>
      <Button variant="secondary" size="sm" icon={DownloadIcon} busy={downloading} onClick={download} className="mt-3 print:hidden" aria-label={`Download QR code for table ${table.number}`}>
        Download
      </Button>
    </li>
  );
}
