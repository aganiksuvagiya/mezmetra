import PDFDocument from 'pdfkit';
import { PAYMENT_LABELS } from './paymentLabels.js';

// The built-in PDF fonts have no rupee glyph, so amounts are printed as "Rs 399.00".
const money = (rupees) => `Rs ${Number(rupees).toFixed(2)}`;
const plain = (rupees) => Number(rupees).toFixed(2);

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(date));
}

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** A whole number in words, grouped the Indian way (thousand, lakh, crore). */
function inWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return [TENS[Math.floor(n / 10)], n % 10 ? ONES[n % 10] : ''].filter(Boolean).join(' ');
  const [size, name] = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand'], [100, 'Hundred']].find(([s]) => n >= s);
  return [inWords(Math.floor(n / size)), name, n % size ? inWords(n % size) : ''].filter(Boolean).join(' ');
}

/** 1250.5 -> "Rupees One Thousand Two Hundred Fifty and Fifty Paise Only" */
export function amountInWords(rupees) {
  const paise = Math.round(Number(rupees) * 100);
  const rest = paise % 100;
  return `Rupees ${inWords(Math.floor(paise / 100))}${rest ? ` and ${inWords(rest)} Paise` : ''} Only`;
}

/** Black or white, whichever can be read on this background colour. */
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111827' : '#ffffff';
}

/** The MezMitra mark (shared/logo.js has the same shapes), `size` points square. */
function drawMark(doc, x, y, size) {
  doc.save();
  doc.translate(x, y).scale(size / 64);
  const shade = doc.linearGradient(0, 0, 64, 64);
  shade.stop(0, '#F7A04B').stop(1, '#D9560F');
  doc.roundedRect(0, 0, 64, 64, 17).fill(shade);
  doc.circle(32, 17, 6.5).fill('#ffffff');
  doc.path('M15 49V25L32 39.5L49 25V49').lineWidth(7.5).lineCap('round').lineJoin('round').stroke('#ffffff');
  doc.restore();
}

const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SHADE = '#f3f4f6';

/**
 * Stream an A4 bill for a paid order into `res` (anything writable).
 * `order` is the admin serialisation (see serialize.adminOrderOut); `vendor` has name, timezone and, optionally, theme_primary,
 * tax_percent and `logo` (the bytes of a JPEG or PNG; other pictures cannot be put in a PDF).
 */
export function writeReceipt(res, { vendor, order }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Bill #${order.number}` } });
  doc.pipe(res);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const colour = /^#[0-9a-f]{6}$/i.test(vendor.theme_primary ?? '') ? vendor.theme_primary : '#2f6f62';
  // Coloured words on white paper must stay readable when the restaurant's colour is a pale one.
  const strong = textOn(colour) === '#ffffff' ? colour : INK;
  // Rows and totals stop here, which leaves room for the footer.
  const floor = doc.page.height - 110;
  const text = (value, x, y, options = {}, { font = 'Helvetica', size = 10, color = INK } = {}) =>
    doc.font(font).fontSize(size).fillColor(color).text(String(value), x, y, options);
  const rule = (y, color = LINE, from = left, to = right) => doc.moveTo(from, y).lineTo(to, y).lineWidth(0.8).strokeColor(color).stroke();

  // --- Header: who the bill is from ------------------------------------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 10).fill(colour);
  const mark = 56;
  let drawn = false;
  if (vendor.logo) {
    try {
      doc.image(vendor.logo, left, 40, { fit: [mark, mark], align: 'center', valign: 'center' });
      drawn = true;
    } catch {
      /* a damaged or unsupported picture: the initial is shown instead */
    }
  }
  if (!drawn) {
    doc.roundedRect(left, 40, mark, mark, 12).fill(colour);
    text([...vendor.name.trim()][0]?.toUpperCase() ?? '', left, 54, { width: mark, align: 'center', lineBreak: false }, { font: 'Helvetica-Bold', size: 28, color: textOn(colour) });
  }
  const nameX = left + mark + 16;
  doc.font('Helvetica-Bold').fontSize(22);
  const nameHeight = doc.heightOfString(vendor.name, { width: 290 });
  const nameTop = 40 + Math.max(0, (mark - nameHeight) / 2); // level with the logo
  text(vendor.name, nameX, nameTop, { width: 290 }, { font: 'Helvetica-Bold', size: 22 });
  const headerEnd = Math.max(nameTop + nameHeight, 40 + mark);
  text('BILL', right - 150, 40, { width: 150, align: 'right' }, { font: 'Helvetica-Bold', size: 28, color: strong });
  doc.roundedRect(right - 70, 76, 70, 22, 11).fill('#dcfce7');
  text('PAID', right - 70, 82, { width: 70, align: 'center', characterSpacing: 1.5, lineBreak: false }, { font: 'Helvetica-Bold', size: 11, color: '#166534' });

  // --- The facts of this bill ------------------------------------------------------------------------------------------
  const factsTop = headerEnd + 22;
  const facts = [
    ['BILL NO.', `#${order.number}`],
    ['DATE AND TIME', formatDate(order.paid_at ?? order.created_at, vendor.timezone)],
    ['TABLE', order.table_number],
    ['PAYMENT', PAYMENT_LABELS[order.payment_method] ?? 'Cash'],
  ];
  const shares = [0.17, 0.33, 0.2, 0.3];
  doc.font('Helvetica-Bold').fontSize(11);
  const factHeight = 36 + Math.max(...facts.map(([, value], i) => doc.heightOfString(String(value), { width: width * shares[i] - 20 })));
  doc.roundedRect(left, factsTop, width, factHeight, 8).fill(SHADE);
  let x = left;
  facts.forEach(([label, value], i) => {
    const cell = width * shares[i];
    text(label, x + 12, factsTop + 11, { width: cell - 20, characterSpacing: 0.6 }, { size: 8, color: MUTED });
    text(value, x + 12, factsTop + 25, { width: cell - 20 }, { font: 'Helvetica-Bold', size: 11 });
    x += cell;
  });

  // --- What was ordered ------------------------------------------------------------------------------------------------
  const cols = { no: [left + 10, 24], item: [left + 40, 245], qty: [left + 292, 38], rate: [left + 340, 75], amount: [left + 420, width - 430] };
  const tableHead = (y) => {
    doc.rect(left, y, width, 26).fill(colour);
    const style = { font: 'Helvetica-Bold', size: 9, color: textOn(colour) };
    for (const [key, label] of [['no', '#'], ['item', 'ITEM'], ['qty', 'QTY'], ['rate', 'RATE (Rs)'], ['amount', 'AMOUNT (Rs)']]) {
      const [cx, cw] = cols[key];
      text(label, cx, y + 9, { width: cw, align: key === 'no' || key === 'item' ? 'left' : 'right', lineBreak: false }, style);
    }
    return y + 26;
  };
  const nextPage = () => {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 10).fill(colour);
    text(`${vendor.name} - Bill #${order.number} (continued)`, left, 28, { width, lineBreak: false, ellipsis: true }, { size: 9, color: MUTED });
    return 50;
  };

  let y = tableHead(factsTop + factHeight + 18);
  order.items.forEach((item, i) => {
    const details = [
      ...item.options.map((o) => `+ ${o.name}${o.price ? ` (${money(o.price)})` : ''}`),
      ...(item.instructions ? [`Note: ${item.instructions}`] : []),
    ].join('\n');
    doc.font('Helvetica-Bold').fontSize(10.5);
    const dishHeight = doc.heightOfString(item.name, { width: cols.item[1] });
    doc.font('Helvetica').fontSize(9);
    const detailHeight = details ? doc.heightOfString(details, { width: cols.item[1] }) + 3 : 0;
    const height = dishHeight + detailHeight + 14;
    if (y + height > floor) y = tableHead(nextPage());
    const top = y + 7;
    text(i + 1, cols.no[0], top, { width: cols.no[1], lineBreak: false }, { color: MUTED });
    text(item.name, cols.item[0], top, { width: cols.item[1] }, { font: 'Helvetica-Bold', size: 10.5 });
    if (details) text(details, cols.item[0], top + dishHeight + 3, { width: cols.item[1] }, { size: 9, color: MUTED });
    text(item.quantity, cols.qty[0], top, { width: cols.qty[1], align: 'right', lineBreak: false });
    // The price of one, extras included, so that quantity x rate is the amount.
    text(plain(item.line_total / item.quantity), cols.rate[0], top, { width: cols.rate[1], align: 'right', lineBreak: false });
    text(plain(item.line_total), cols.amount[0], top, { width: cols.amount[1], align: 'right', lineBreak: false }, { font: 'Helvetica-Bold' });
    y += height;
    rule(y);
  });

  // --- Totals ------------------------------------------------------------------------------------------------------------
  if (y + 130 > floor) y = nextPage();
  y += 16;
  const boxX = right - 230;
  const totalRow = (label, value) => {
    text(label, boxX + 12, y, { width: 110, lineBreak: false }, { color: MUTED });
    text(money(value), boxX + 100, y, { width: 120, align: 'right', lineBreak: false });
    y += 19;
  };
  const wordsTop = y;
  totalRow('Subtotal', order.subtotal);
  if (order.tax > 0) {
    // The rate is named only when it gives exactly this tax (the restaurant may have changed its rate since).
    const rate = Number(vendor.tax_percent);
    const fits = rate > 0 && Math.round((Math.round(order.subtotal * 100) * rate) / 100) === Math.round(order.tax * 100);
    totalRow(fits ? `Tax (${rate}%)` : 'Tax', order.tax);
  }
  y += 4;
  doc.roundedRect(boxX, y, 230, 34, 8).fill(colour);
  text('TOTAL', boxX + 12, y + 12, { width: 80, lineBreak: false }, { font: 'Helvetica-Bold', size: 11, color: textOn(colour) });
  text(money(order.total), boxX + 80, y + 9, { width: 138, align: 'right', lineBreak: false }, { font: 'Helvetica-Bold', size: 16, color: textOn(colour) });
  const totalsEnd = y + 34;

  const wordsWidth = boxX - left - 24;
  text('AMOUNT IN WORDS', left, wordsTop, { width: wordsWidth, characterSpacing: 0.6 }, { size: 8, color: MUTED });
  text(amountInWords(order.total), left, wordsTop + 13, { width: wordsWidth }, { font: 'Helvetica-Bold' });
  const quantity = order.items.reduce((n, item) => n + item.quantity, 0);
  text(`Items: ${order.items.length}    Total quantity: ${quantity}`, left, Math.max(doc.y + 10, totalsEnd - 12), { width: wordsWidth }, { size: 9, color: MUTED });

  // --- Footer, at the foot of the last page ------------------------------------------------------------------------------
  const foot = doc.page.height - 96;
  rule(foot);
  text('Thank you! Visit again.', left, foot + 12, { width, align: 'center', lineBreak: false }, { font: 'Helvetica-Bold', size: 12, color: strong });
  text('This is a computer-generated bill and needs no signature.', left, foot + 30, { width, align: 'center', lineBreak: false }, { size: 8.5, color: MUTED });
  // "[mark] Billed with MezMitra", centred as one.
  doc.font('Helvetica').fontSize(8);
  const credit = doc.widthOfString('Billed with MezMitra');
  const creditX = left + (width - credit - 15) / 2;
  drawMark(doc, creditX, foot + 41, 11);
  text('Billed with MezMitra', creditX + 15, foot + 43, { lineBreak: false }, { size: 8, color: MUTED });
  doc.end();
}
