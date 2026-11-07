import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api.js';
import { formatBytes, prepareImage } from '../lib/image.js';
import { Button } from './Button.jsx';
import { ImageIcon, UploadIcon } from './icons.jsx';

/**
 * Photo picker for a menu item. Controlled through `photo = { blob, removed }`:
 *  - `blob` is a freshly prepared (downscaled, compressed) image waiting to be uploaded after the item is saved;
 *  - `removed` means "delete the stored photo on save".
 * `existingUrl` is the item's current `photo_url` (or null).
 */
export default function PhotoField({ existingUrl, photo, onChange, disabled }) {
  const inputRef = useRef(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [brokenExisting, setBrokenExisting] = useState(false);

  // Preview of the prepared image; revoked when replaced or when the form closes.
  useEffect(() => {
    if (!photo.blob) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(photo.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.blob]);

  const showingExisting = !photo.blob && !photo.removed && existingUrl && !brokenExisting;
  const shown = photo.blob ? previewUrl : showingExisting ? apiUrl(existingUrl) : null;

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setError(null);
    setProcessing(true);
    try {
      const { blob } = await prepareImage(file);
      onChange({ blob, removed: false });
    } catch (err) {
      setError(err.message || 'That image could not be used.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50 text-slate-400">
        {shown ? (
          <img src={shown} alt="Dish photo preview" className="size-full object-cover" onError={() => !photo.blob && setBrokenExisting(true)} />
        ) : (
          <ImageIcon size={32} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <input ref={inputRef} type="file" accept="image/*" onChange={pick} tabIndex={-1} aria-label="Choose a photo file" className="sr-only" disabled={disabled} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={UploadIcon} busy={processing} disabled={disabled} onClick={() => inputRef.current?.click()}>
            {processing ? 'Preparing…' : shown ? 'Replace photo' : 'Choose photo'}
          </Button>
          {shown && !processing && (
            <Button variant="danger-outline" size="sm" disabled={disabled} onClick={() => { setError(null); onChange({ blob: null, removed: true }); }}>
              Remove photo
            </Button>
          )}
        </div>

        <p className="mt-2 text-xs text-slate-500" aria-live="polite">
          {photo.blob
            ? `New photo ready (${formatBytes(photo.blob.size)}). It uploads when you save.`
            : photo.removed && existingUrl
              ? 'The photo will be removed when you save.'
              : 'JPEG, PNG or WebP. Photos are resized to 900px and compressed in your browser before upload.'}
        </p>
        {error && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
