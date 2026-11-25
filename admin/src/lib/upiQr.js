import { prepareImage } from './image.js';

// The restaurant uploads a screenshot of its UPI QR. Whatever the size, we look for the QR inside it (the browser's built-in QR
// detector), check that it is a UPI payment QR, and keep only the QR: cropped, on a white margin, as a crisp PNG. A whole-phone
// screenshot, a tiny picture or a photo with a lot around the code all come out the same: a clean QR a phone can scan.
// Browsers without the detector (Firefox, older Safari) fall back to the plain shrink-and-upload, with a warning.

const TARGET_MIN = 640; // the cropped QR is drawn at least this wide (small ones are enlarged without blurring the squares)
const TARGET_MAX = 800;
const MARGIN = 0.12; // white border around the code, as a share of its size (the "quiet zone" scanners need)
const MAX_DETECT_SIDE = 3000;

export const canReadQr = () => typeof window !== 'undefined' && 'BarcodeDetector' in window;

const upiPayload = (raw) => /^upi:\/\/pay\?/i.test(String(raw ?? '').trim());
const payeeOf = (raw) => new URLSearchParams(String(raw).trim().split('?')[1] ?? '').get('pa');

function drawScaled(bitmap, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // flatten transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Does this picture still read as exactly this QR? */
async function readsAs(blob, rawValue) {
  try {
    const bitmap = await createImageBitmap(blob);
    const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
    bitmap.close?.();
    return codes.some((c) => c.rawValue === rawValue);
  } catch {
    return false;
  }
}

/** Looks for QR codes in the image, trying it as it is, smaller (a huge photo) and larger (a tiny picture). */
async function findQr(bitmap) {
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scales = [Math.min(1, MAX_DETECT_SIDE / longSide)];
  if (longSide > 1400) scales.push(1200 / longSide);
  if (longSide < 600) scales.push(900 / longSide);
  for (const scale of scales) {
    const canvas = drawScaled(bitmap, scale);
    let codes = [];
    try {
      codes = await detector.detect(canvas);
    } catch {
      codes = [];
    }
    if (codes.length > 0) {
      const best = codes.reduce((a, b) => (b.boundingBox.width * b.boundingBox.height > a.boundingBox.width * a.boundingBox.height ? b : a));
      return { canvas, code: best };
    }
  }
  return null;
}

/**
 * @returns {Promise<{ blob: Blob, vpa: string|null, checked: boolean }>} `checked` is false when this browser cannot read QR codes
 *   (the image is then only shrunk); otherwise `vpa` is the UPI ID the QR pays. Throws an Error with a message that is safe to show.
 */
export async function prepareUpiQr(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Please choose an image (JPEG, PNG or WebP).');

  if (!canReadQr()) {
    const { blob } = await prepareImage(file, { maxSide: 1000, maxBytes: 600 * 1024 });
    return { blob, vpa: null, checked: false };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That image could not be read. Try a JPEG, PNG or WebP file.');
  }
  try {
    const found = await findQr(bitmap);
    if (!found) {
      throw new Error('We could not find a QR code in this image. Use a clear screenshot of your QR from the PhonePe Business or Paytm app.');
    }
    const { canvas, code } = found;
    if (!upiPayload(code.rawValue)) {
      throw new Error('This QR is not a UPI payment QR. Upload the QR from your PhonePe Business or Paytm for Business app, the one customers scan to pay you.');
    }

    // Keep only the QR, centred on a white square with a quiet-zone margin.
    const { x, y, width, height } = code.boundingBox;
    const size = Math.max(width, height);
    const margin = Math.round(size * MARGIN);
    const side = size + margin * 2;
    const out = Math.min(TARGET_MAX, Math.max(TARGET_MIN, side));
    const cropped = document.createElement('canvas');
    cropped.width = out;
    cropped.height = out;
    const ctx = cropped.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out, out);
    ctx.imageSmoothingEnabled = out < side; // shrinking: smooth; enlarging: keep the squares crisp
    ctx.imageSmoothingQuality = 'high';
    const ratio = out / side;
    const offsetX = (size - width) / 2;
    const offsetY = (size - height) / 2;
    ctx.drawImage(canvas, x, y, width, height, (margin + offsetX) * ratio, (margin + offsetY) * ratio, width * ratio, height * ratio);

    const toBlob = (type, quality) => new Promise((resolve) => cropped.toBlob(resolve, type, quality));
    const png = await toBlob('image/png');
    if (!png) throw new Error('This browser could not process the image.');
    // A coloured QR (logo, gradients) can be a big PNG. Try a lighter WebP, and keep it only if it still reads as the same QR.
    let blob = png;
    if (png.size > 300 * 1024) {
      const webp = await toBlob('image/webp', 0.92);
      if (webp && webp.type === 'image/webp' && webp.size < png.size && (await readsAs(webp, code.rawValue))) blob = webp;
    }
    if (blob.size > 900 * 1024) throw new Error('This image is too detailed. Try a plain screenshot of the QR.');
    return { blob, vpa: payeeOf(code.rawValue), checked: true };
  } finally {
    bitmap.close?.();
  }
}
