import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config } from './config.js';
import { createDb } from './db.js';
import { TEA_POST } from './seed.js';
import { drawCredit } from './lib/credit.js';

// Printable table QR codes for a restaurant: one PNG per table, a zip-ready folder and an A4 PDF of table cards.
//   npm run demo:qr                      (Tea Post)
//   npm run demo:qr -- --email you@x.in  (another restaurant)
// The links use CUSTOMER_APP_URL (backend/.env), so run it again whenever that address changes (for example a new Wi-Fi).
// Files go to demo/<restaurant>/ (git-ignored: the QR tokens belong to the live database).

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const email = String(arg('email', TEA_POST.email)).toLowerCase();

const db = await createDb();
try {
  const vendor = (await db.query(`SELECT id, name, theme_primary FROM vendors WHERE lower(email) = $1`, [email])).rows[0];
  if (!vendor) throw new Error(`No restaurant with the email ${email}.`);
  const tables = (await db.query(`SELECT number, qr_token FROM dining_tables WHERE vendor_id = $1 AND is_active ORDER BY id`, [vendor.id])).rows;
  if (tables.length === 0) throw new Error(`${vendor.name} has no active tables.`);

  const slug = vendor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const out = path.resolve('..', 'demo', slug);
  fs.mkdirSync(out, { recursive: true });
  const link = (t) => `${config.customerAppUrl}/t/${t.qr_token}`;

  const links = {};
  for (const t of tables) {
    await QRCode.toFile(path.join(out, `${slug}-${t.number}.png`), link(t), { width: 900, margin: 3, errorCorrectionLevel: 'H' });
    links[t.number] = link(t);
  }

  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `${vendor.name} - table QR codes` } });
  doc.pipe(fs.createWriteStream(path.join(out, `${slug}-table-qr-cards.pdf`)));
  const CARD_W = 255, CARD_H = 258, GAP_X = 20, GAP_Y = 12;
  const left = (595 - (CARD_W * 2 + GAP_X)) / 2;
  for (const [i, t] of tables.entries()) {
    const slot = i % 6;
    if (i > 0 && slot === 0) doc.addPage();
    const x = left + (slot % 2) * (CARD_W + GAP_X);
    const y = 26 + Math.floor(slot / 2) * (CARD_H + GAP_Y);
    doc.roundedRect(x, y, CARD_W, CARD_H, 14).lineWidth(1.2).strokeColor(vendor.theme_primary).stroke();
    doc.fillColor(vendor.theme_primary).font('Helvetica-Bold').fontSize(20).text(vendor.name, x, y + 14, { width: CARD_W, align: 'center' });
    doc.fillColor('#555').font('Helvetica').fontSize(9.5).text('Scan to see the menu and order from your table', x + 20, y + 40, { width: CARD_W - 40, align: 'center' });
    const png = await QRCode.toBuffer(link(t), { width: 700, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#1f1209', light: '#ffffff' } });
    doc.image(png, x + (CARD_W - 150) / 2, y + 58, { width: 150, height: 150 });
    doc.fillColor('#1f1209').font('Helvetica-Bold').fontSize(18).text(`Table ${t.number}`, x, y + 212, { width: CARD_W, align: 'center' });
    drawCredit(doc, { centerX: x + CARD_W / 2, y: y + 240 });
  }
  doc.end();
  fs.writeFileSync(path.join(out, 'links.json'), JSON.stringify(links, null, 2));

  console.log(`${vendor.name}: ${tables.length} QR codes in ${path.relative(process.cwd(), out)}/ (PDF cards + PNGs)`);
  for (const [n, u] of Object.entries(links)) console.log(`  ${n}  ${u}`);
} finally {
  await db.close();
}
