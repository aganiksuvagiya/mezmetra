import { useRef, useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import { ImageIcon, UploadIcon } from './icons.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, apiUrl } from '../lib/api.js';
import { formatBytes, prepareImage } from '../lib/image.js';

/** Upload / replace / remove the restaurant's logo. It saves straight away (no Save button), like a profile photo. */
export default function LogoCard() {
  const { vendor, updateVendor } = useAuth();
  const toast = useToast();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null); // 'upload' | 'remove' | null
  const [error, setError] = useState(null);
  const [brokenUrl, setBrokenUrl] = useState(null);
  const shown = vendor.logo_url && brokenUrl !== vendor.logo_url ? apiUrl(vendor.logo_url) : null;

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const { blob } = await prepareImage(file, { maxSide: 512, maxBytes: 200 * 1024 });
      const updated = await api('/api/admin/vendor/logo', { method: 'PUT', body: blob });
      updateVendor(updated);
      toast.success(`Logo saved (${formatBytes(blob.size)}). Diners see it on your menu now.`);
    } catch (err) {
      setError(err.message || 'That image could not be used.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy('remove');
    try {
      updateVendor(await api('/api/admin/vendor/logo', { method: 'DELETE' }));
      toast.success('Logo removed.');
    } catch (err) {
      setError(err.message || 'Could not remove the logo.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card as="section" aria-labelledby="logo">
      <CardHeader id="logo" title="Logo" description="Shown at the top of your customer menu and order pages." />
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
        <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-white text-slate-400">
          {shown ? (
            <img src={shown} alt="Your logo" className="size-full object-contain p-2" onError={() => setBrokenUrl(vendor.logo_url)} />
          ) : (
            <ImageIcon size={32} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <input ref={inputRef} type="file" accept="image/*" onChange={pick} tabIndex={-1} aria-label="Choose a logo file" className="sr-only" disabled={busy !== null} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={UploadIcon} busy={busy === 'upload'} disabled={busy !== null} onClick={() => inputRef.current?.click()}>
              {busy === 'upload' ? 'Uploading…' : shown ? 'Replace logo' : 'Upload logo'}
            </Button>
            {shown && (
              <Button variant="danger-outline" size="sm" busy={busy === 'remove'} disabled={busy !== null} onClick={remove}>
                Remove logo
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500" aria-live="polite">
            JPEG, PNG or WebP. A square logo on a plain background looks best. It is resized to 512px in your browser before upload.
          </p>
          {error && (
            <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
