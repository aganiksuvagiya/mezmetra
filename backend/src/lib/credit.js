// "Made with ♥ by Raavora" - the small credit printed under table QR codes (and anything else we print for a restaurant).
// pdfkit's built-in fonts have no heart glyph, so the heart is drawn as a vector shape.

export const CREDIT = { by: 'Raavora', site: 'raavora.com' };

const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

/**
 * Draws "Made with ♥ by Raavora · raavora.com" centred on `centerX`, with its text baseline area starting at `y`.
 * Returns the height used so callers can place things below it.
 */
export function drawCredit(doc, { centerX, y, size = 7.5, color = '#8a8a8a', heart = '#e11d48' }) {
  const heartSize = size * 1.15;
  const gap = size * 0.35;
  doc.font('Helvetica').fontSize(size);
  const left = 'Made with';
  const right = `by `;
  const brand = CREDIT.by;
  const tail = `  ·  ${CREDIT.site}`;
  doc.font('Helvetica').fontSize(size);
  const wLeft = doc.widthOfString(left);
  const wRight = doc.widthOfString(right);
  doc.font('Helvetica-Bold');
  const wBrand = doc.widthOfString(brand);
  doc.font('Helvetica');
  const wTail = doc.widthOfString(tail);
  const total = wLeft + gap + heartSize + gap + wRight + wBrand + wTail;
  let x = centerX - total / 2;

  doc.fillColor(color).font('Helvetica').fontSize(size).text(left, x, y, { lineBreak: false });
  x += wLeft + gap;
  doc.save().translate(x, y - heartSize * 0.12).scale(heartSize / 24).path(HEART).fill(heart).restore();
  x += heartSize + gap;
  doc.fillColor(color).font('Helvetica').fontSize(size).text(right, x, y, { lineBreak: false });
  x += wRight;
  doc.fillColor('#555').font('Helvetica-Bold').fontSize(size).text(brand, x, y, { lineBreak: false });
  x += wBrand;
  doc.fillColor(color).font('Helvetica').fontSize(size).text(tail, x, y, { lineBreak: false });
  return size * 1.3;
}
