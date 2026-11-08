// Menu photos are downscaled in the browser before upload: max 900px on the long side, WebP (JPEG as a fallback
// for browsers that cannot encode WebP), quality lowered until the file is <= 400 KB (the API accepts 512 KB).

export const MAX_SIDE = 900;
export const MAX_BYTES = 400 * 1024;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Resolves to `{ blob, width, height }` or throws an Error with a message that is safe to show. */
export async function prepareImage(file, { maxSide = MAX_SIDE, maxBytes = MAX_BYTES } = {}) {
  if (!file?.type?.startsWith('image/')) throw new Error('Please choose an image (JPEG, PNG or WebP).');

  let source;
  try {
    source = await decode(file);
  } catch {
    throw new Error('That image could not be read. Try a JPEG, PNG or WebP file.');
  }
  const srcW = source.naturalWidth ?? source.width;
  const srcH = source.naturalHeight ?? source.height;
  if (!srcW || !srcH) throw new Error('That image could not be read. Try a JPEG, PNG or WebP file.');

  let scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  let type = 'image/webp';

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const width = Math.max(1, Math.round(srcW * scale));
      const height = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // flatten transparency (also needed for JPEG)
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, width, height);

      for (let quality = 0.86; quality >= 0.38; quality -= 0.12) {
        let blob = await toBlob(canvas, type, quality);
        if (type === 'image/webp' && (!blob || blob.type !== 'image/webp')) {
          type = 'image/jpeg'; // this browser cannot encode WebP
          blob = await toBlob(canvas, type, quality);
        }
        if (!blob) throw new Error('This browser could not process the image.');
        if (blob.size <= maxBytes) return { blob, width, height };
      }
      scale *= 0.8; // still too big at the lowest quality: shrink and try again
    }
  } finally {
    source.close?.();
  }
  throw new Error(`This image is too detailed to shrink below ${Math.round(maxBytes / 1024)} KB. Try a simpler or smaller image.`);
}

export const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
