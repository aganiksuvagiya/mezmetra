import { Button } from '../../components/Button.jsx';
import { ErrorState } from '../../components/EmptyState.jsx';
import { DownloadIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { downloadUrl, useBlobUrl } from '../../lib/hooks.js';
import { slug } from '../../lib/format.js';

/** Shows one table's QR code (fetched with the auth header) with a high-resolution PNG download. */
export default function QrModal({ table, onClose }) {
  const qr = useBlobUrl(`/api/admin/tables/${table.id}/qr.png?size=1024`);

  return (
    <Modal
      title={`QR code · Table ${table.number}`}
      description="Diners scan this code to open your menu for this table."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button icon={DownloadIcon} disabled={!qr.url} onClick={() => downloadUrl(qr.url, `table-${slug(table.number)}-qr.png`)}>
            Download PNG
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex aspect-square w-64 max-w-full items-center justify-center rounded-xl border border-slate-200 bg-white p-2">
          {qr.loading && (
            <span role="status" className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner size={18} /> Loading…
            </span>
          )}
          {qr.url && <img src={qr.url} alt={`QR code for table ${table.number}`} className="size-full" />}
          {qr.error && <ErrorState error={qr.error} onRetry={qr.retry} title="Couldn't load the QR code" className="py-4" />}
        </div>
        <p className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">{table.qr_url}</p>
        {!table.is_active && <p className="text-center text-xs font-medium text-amber-800">This table is switched off, so the code won&rsquo;t take orders until you turn it back on.</p>}
      </div>
    </Modal>
  );
}
