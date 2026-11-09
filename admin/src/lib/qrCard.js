// A complete, printable table card as a PNG: restaurant logo + name, "scan to order", the QR code, the table number and the
// "Made with ♥ by Raavora" credit. Drawn in the browser (canvas) from the QR image the API already serves, so what the owner
// sees in the preview is exactly what they download and print.

import { CREDIT } from './brand.js';

export const CARD_W = 1200;
export const CARD_H = 1680;
const QR_SIZE = 860;
const FONT = '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = src;
  });

/** The logo is fetched (CORS) and drawn from a blob URL so it cannot taint the canvas; any problem just means "no logo". */
async function loadLogo(src) {
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    try {
      return await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/** Shrinks the font until `text` fits in `maxWidth` (restaurant names can be long). */
function fitFont(ctx, text, weight, startPx, maxWidth, minPx = 40) {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (px > minPx && ctx.measureText(text).width > maxWidth) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  return px;
}

/** Word-wraps `text` into at most `maxLines` lines that fit `maxWidth`. */
function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/**
 * @param {{ qrSrc: string, restaurantName: string, tableNumber: string, color?: string, logoSrc?: string|null }} p
 *   `qrSrc` is an image URL (the blob URL of the QR PNG); `logoSrc` is optional.
 * @returns {Promise<Blob>} a PNG, CARD_W x CARD_H
 */
export async function buildQrCard({ qrSrc, restaurantName, tableNumber, color = '#2f6f62', logoSrc = null }) {
  await document.fonts?.ready?.catch?.(() => {});
  const [qr, logo] = await Promise.all([loadImage(qrSrc), logoSrc ? loadLogo(logoSrc) : null]);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Card: white, with a rounded border in the restaurant's colour.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.lineWidth = 12;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.roundRect(36, 36, CARD_W - 72, CARD_H - 72, 70);
  ctx.stroke();

  let y = 120;
  const cx = CARD_W / 2;

  if (logo) {
    const box = 170;
    const scale = Math.min(box / logo.width, box / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    ctx.drawImage(logo, cx - w / 2, y, w, h);
    y += box + 40;
  } else {
    y += 20;
  }

  // Restaurant name (up to two lines).
  ctx.fillStyle = color;
  const namePx = fitFont(ctx, restaurantName, 800, 96, CARD_W - 220, 56);
  const lines = wrap(ctx, restaurantName, CARD_W - 220, 2);
  for (const line of lines) {
    y += namePx;
    ctx.fillText(line, cx, y);
    y += 12;
  }

  ctx.fillStyle = '#5b5b5f';
  ctx.font = `500 42px ${FONT}`;
  y += 54;
  ctx.fillText('Scan to see the menu and order from your table', cx, y);
  y += 56;

  // QR code, drawn crisp (no smoothing). A logo and a long, two-line name take room, so the code shrinks a little to leave
  // space for the table number and the credit below it (the card itself keeps one fixed size).
  const qrTop = y;
  const qrSize = Math.min(QR_SIZE, CARD_H - 360 - qrTop);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, cx - qrSize / 2, qrTop, qrSize, qrSize);
  ctx.imageSmoothingEnabled = true;

  // Table number.
  ctx.fillStyle = '#1c1c1e';
  fitFont(ctx, `Table ${tableNumber}`, 800, 130, CARD_W - 240, 64);
  ctx.fillText(`Table ${tableNumber}`, cx, Math.min(CARD_H - 230, qrTop + qrSize + 150));

  // Credit: "Made with ♥ by Raavora · raavora.com"
  const baseline = CARD_H - 110;
  const size = 34;
  const heart = size * 1.1;
  const gap = 10;
  ctx.textAlign = 'left';
  ctx.font = `500 ${size}px ${FONT}`;
  const wMade = ctx.measureText('Made with').width;
  const wBy = ctx.measureText('by ').width;
  const wTail = ctx.measureText(`  ·  ${CREDIT.site}`).width;
  ctx.font = `700 ${size}px ${FONT}`;
  const wBrand = ctx.measureText(CREDIT.by).width;
  let x = cx - (wMade + gap + heart + gap + wBy + wBrand + wTail) / 2;
  ctx.fillStyle = '#8a8a8e';
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillText('Made with', x, baseline);
  x += wMade + gap;
  ctx.save();
  ctx.translate(x, baseline - heart * 0.88);
  ctx.scale(heart / 24, heart / 24);
  ctx.fillStyle = '#e11d48';
  ctx.fill(new Path2D(HEART));
  ctx.restore();
  x += heart + gap;
  ctx.fillStyle = '#8a8a8e';
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillText('by ', x, baseline);
  x += wBy;
  ctx.fillStyle = '#555559';
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.fillText(CREDIT.by, x, baseline);
  x += wBrand;
  ctx.fillStyle = '#8a8a8e';
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillText(`  ·  ${CREDIT.site}`, x, baseline);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the card image.'))), 'image/png'));
}
