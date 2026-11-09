import { useEffect, useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { ErrorState } from '../../components/EmptyState.jsx';
import { DownloadIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { apiUrl } from '../../lib/api.js';
import { slug } from '../../lib/format.js';
import { downloadUrl, useBlobUrl } from '../../lib/hooks.js';
import { buildQrCard } from '../../lib/qrCard.js';

/**
 * One table's printable card: restaurant, "scan to order", QR code, table number and the Raavora credit. The preview is the very
 * image that gets downloaded. "QR only" gives the bare code for owners who lay out their own table stands.
 */
export default function QrModal({ table, onClose }) {
  const { vendor } = useAuth();
  const qr = useBlobUrl(`/api/admin/tables/${table.id}/qr.png?size=860`);
  const [card, setCard] = useState({ url: null, error: null });

  useEffect(() => {
    if (!qr.url) return undefined;
    let cancelled = false;
    let made = null;
    setCard({ url: null, error: null });
    buildQrCard({
      qrSrc: qr.url,
      restaurantName: vendor?.name ?? 'Your restaurant',
      tableNumber: table.number,
      color: vendor?.theme?.primary,
      logoSrc: vendor?.logo_url ? apiUrl(vendor.logo_url) : null,
    })
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setCard({ url: made, error: null });
      })
      .catch((error) => !cancelled && setCard({ url: null, error }));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [qr.url, vendor?.name, vendor?.theme?.primary, vendor?.logo_url, table.number]);

  const loading = qr.loading || (qr.url && !card.url && !card.error);
  const error = qr.error || card.error;

  return (
    <Modal
      title={`QR code · Table ${table.number}`}
      description="Print this card and place it on the table. Diners scan the code to open your menu."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" disabled={!qr.url} onClick={() => downloadUrl(qr.url, `table-${slug(table.number)}-qr-only.png`)}>
            QR only
          </Button>
          <Button icon={DownloadIcon} disabled={!card.url} onClick={() => downloadUrl(card.url, `table-${slug(table.number)}-card.png`)}>
            Download card
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex w-64 max-w-full items-center justify-center rounded-xl border border-slate-200 bg-white p-1.5">
          {loading && (
            <span role="status" className="flex aspect-[5/7] items-center gap-2 text-sm text-slate-500">
              <Spinner size={18} /> Loading…
            </span>
          )}
          {card.url && <img src={card.url} alt={`Printable card for table ${table.number}`} className="w-full" />}
          {error && !loading && <ErrorState error={error} onRetry={qr.retry} title="Couldn't prepare the card" className="py-4" />}
        </div>
        <p className="w-full break-all rounded-lg bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">{table.qr_url}</p>
        {!table.is_active && <p className="text-center text-xs font-medium text-amber-800">This table is switched off, so the code won&rsquo;t take orders until you turn it back on.</p>}
      </div>
    </Modal>
  );
}
