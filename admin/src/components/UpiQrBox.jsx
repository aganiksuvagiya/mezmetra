import { useRef, useState } from 'react';
import { Button } from './Button.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { UploadIcon } from './icons.jsx';
import { useToast } from './Toast.jsx';
import { api, apiUrl } from '../lib/api.js';
import { formatBytes } from '../lib/image.js';
import { canReadQr, prepareUpiQr } from '../lib/upiQr.js';

/**
 * The restaurant's own UPI QR (from the PhonePe Business or Paytm for Business app). A business ID from those apps accepts money only
 * through its QR: a payment link gets "as per UPI guidelines, payment through a link is not allowed for this merchant". Diners see this
 * QR on their order page and scan it. Saves straight away (no Save button), like the logo.
 */
export default function UpiQrBox({ initialUrl, upiId = '', onUseUpiId }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [url, setUrl] = useState(initialUrl ?? null);
  const [busy, setBusy] = useState(null); // 'upload' | null
  const [foundId, setFoundId] = useState(null); // the UPI ID the uploaded QR pays
  const [unchecked, setUnchecked] = useState(false); // this browser could not read the QR, so it was not checked
  const [error, setError] = useState(null);
  const [broken, setBroken] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const { blob, vpa, checked } = await prepareUpiQr(file);
      const saved = await api('/api/admin/payment-settings/upi-qr', { method: 'PUT', body: blob });
      setUrl(saved.upi_qr_url);
      setBroken(false);
      setFoundId(vpa);
      setUnchecked(!checked);
      toast.success(`QR saved (${formatBytes(blob.size)}). Diners see it on their order page now.`);
    } catch (err) {
      setError(err.message || 'That image could not be used.');
    } finally {
      setBusy(null);
    }
  };

  // Asked first (ConfirmDialog): a failure is shown inside that dialog, which stays open.
  const remove = async () => {
    const saved = await api('/api/admin/payment-settings/upi-qr', { method: 'DELETE' });
    setUrl(saved.upi_qr_url);
    setFoundId(null);
    setConfirmingRemove(false);
    toast.success('QR removed.');
  };

  const shown = url && !broken ? apiUrl(url) : null;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const idDiffers = Boolean(foundId) && norm(foundId) !== norm(upiId);

  return (
    <div className="rounded-xl border border-black/[0.08] p-3 sm:p-4">
      <p className="text-sm font-medium text-slate-900">Your UPI QR code</p>
      <p className="mt-0.5 text-xs text-slate-500">
        If your UPI ID is from <strong>PhonePe Business</strong> or <strong>Paytm for Business</strong>, it accepts money only through its own QR (a link says
        “payment through a link is not allowed for this merchant”). Upload that QR here: diners scan it on their order page.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white text-xs text-slate-400">
          {shown ? <img src={shown} alt="Your UPI QR code" className="size-full object-contain p-1" onError={() => setBroken(true)} /> : 'No QR yet'}
        </div>
        <div className="min-w-0 flex-1">
          <input ref={inputRef} type="file" accept="image/*" onChange={pick} tabIndex={-1} aria-label="Choose your UPI QR image" className="sr-only" disabled={busy !== null} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={UploadIcon} busy={busy === 'upload'} disabled={busy !== null} onClick={() => inputRef.current?.click()}>
              {busy === 'upload' ? 'Uploading…' : shown ? 'Replace QR' : 'Upload QR'}
            </Button>
            {shown && (
              <Button variant="danger-outline" size="sm" disabled={busy !== null} onClick={() => setConfirmingRemove(true)}>
                Remove QR
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500" aria-live="polite">
            In the PhonePe Business or Paytm app, open your QR, take a screenshot and upload it. {canReadQr() ? 'Any size works: we find the QR in the picture and keep just that, sharp and clear. ' : ''}JPEG, PNG or WebP.
            With a QR saved, diners are not shown the UPI app buttons.
          </p>
          {unchecked && (
            <p role="status" className="mt-1.5 text-xs font-medium text-amber-800">
              This browser can’t read QR codes, so the picture was not checked. Use a screenshot that shows only the QR, or upload from Google Chrome.
            </p>
          )}
          {idDiffers && (
            <div role="status" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
              This QR pays <strong className="break-all">{foundId}</strong>
              {upiId.trim() ? (
                <>
                  , but your UPI ID above is <strong className="break-all">{upiId.trim()}</strong>
                </>
              ) : (
                ', and your UPI ID above is empty'
              )}
              . Diners pay whoever the QR belongs to.
              {onUseUpiId && (
                <button type="button" onClick={() => onUseUpiId(foundId)} className="ml-1 font-semibold underline underline-offset-2">
                  Use {foundId} as my UPI ID
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        title="Remove your UPI QR?"
        message="Diners will no longer see your QR on their order page. You can upload it again any time."
        confirmLabel="Remove QR"
        onConfirm={remove}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}
