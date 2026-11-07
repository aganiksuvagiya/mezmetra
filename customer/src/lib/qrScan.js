// QR decoding helpers. Uses the browser's native BarcodeDetector when it exists (fast, Chrome/Android) and
// falls back to jsQR (pure JS, works everywhere, loaded on demand) so scanning also works on iPhones and desktops.

let jsQRPromise;
const loadJsQR = () => (jsQRPromise ??= import('jsqr').then((m) => m.default));

let detector;
function nativeDetector() {
  if (detector !== undefined) return detector;
  try {
    detector = 'BarcodeDetector' in globalThis ? new globalThis.BarcodeDetector({ formats: ['qr_code'] }) : null;
  } catch {
    detector = null;
  }
  return detector;
}

/** Decode a QR code drawn on `canvas`. Resolves to the encoded text, or null when none is found. */
export async function decodeCanvas(canvas) {
  const native = nativeDetector();
  if (native) {
    try {
      const found = await native.detect(canvas);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch {
      /* the native detector can throw on some inputs; jsQR below is the safety net */
    }
  }
  const jsQR = await loadJsQR();
  const { width, height } = canvas;
  if (!width || !height) return null;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* e.g. HEIC in some browsers: the <img> path below can still decode it */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode a QR code from a photo the diner picked. Tries a few sizes because very large photos can defeat jsQR. */
export async function decodeImageFile(file) {
  const bitmap = await loadBitmap(file);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const canvas = document.createElement('canvas');
  try {
    for (const maxSide of [1600, 1000, 640]) {
      const scale = Math.min(1, maxSide / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const text = await decodeCanvas(canvas);
      if (text) return text;
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

/** Why the camera cannot be used, before even asking: 'insecure' (plain http), 'unsupported', or null. */
export function cameraProblem() {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

/** Friendly text for a getUserMedia failure. */
export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this site in your browser settings, or use a photo of the QR code instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Use a photo of the QR code or paste the link instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy in another app. Close it and try again, or use a photo instead.';
    default:
      return 'We could not start the camera. Use a photo of the QR code or paste the link instead.';
  }
}

export const CAMERA_PROBLEM_TEXT = {
  insecure: 'The camera only works on a secure (https) connection. Use a photo of the QR code or paste the link instead.',
  unsupported: "This browser can't open the camera. Use a photo of the QR code or paste the link instead.",
};
