import PDFDocument from 'pdfkit';

// The built-in PDF fonts have no rupee glyph, so amounts are printed as "Rs 399.00" (same as receipts).
const money = (rupees) => `Rs ${Number(rupees).toFixed(2)}`;
const METHOD = { upi: 'UPI', cash: 'Cash', razorpay: 'Online (Razorpay)', cashfree: 'Online (Cashfree)' };
const STATUS = { pending: 'Pending', accepted: 'Accepted', completed: 'Completed', cancelled: 'Cancelled' };

const when = (date, timeZone) =>
  date ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(date)) : '-';
const day = (iso) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

/** Streams the sales report as an A4 PDF into `res`. `report` is what routes/reports.js builds (summary + orders). */
export function writeReportPdf(res, report) {
  const { vendor, from, to, summary, orders } = report;
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Sales report ${from} to ${to}` } });
  doc.pipe(res);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#000').text(vendor.name);
  doc.font('Helvetica').fontSize(11).fillColor('#444').text(from === to ? `Sales report, ${day(from)}` : `Sales report, ${day(from)} to ${day(to)}`);
  doc.fontSize(8.5).fillColor('#777').text(`Prepared ${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: vendor.timezone }).format(new Date())} (${vendor.timezone})`);
  doc.moveDown(1);

  const row = (label, value, { bold = false, indent = 0 } = {}) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#000').text(label, left + indent, y, { width: 300 });
    doc.text(value, right - 150, y, { width: 150, align: 'right' });
  };
  const heading = (text) => {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#7a3e1d').text(text);
    doc.moveTo(left, doc.y + 1).lineTo(right, doc.y + 1).strokeColor('#ddd').stroke();
    doc.moveDown(0.4);
  };

  heading('Money received (counted on the day it was paid)');
  row('Total received', `${money(summary.sales.total)}  (${summary.sales.orders} paid orders)`, { bold: true });
  for (const m of summary.sales.by_method) {
    if (m.orders > 0) row(`${METHOD[m.method] ?? m.method}`, `${money(m.amount)}  (${m.orders})`, { indent: 12 });
  }
  row('Dishes and extras', money(summary.sales.subtotal), { indent: 12 });
  row('Tax', money(summary.sales.tax), { indent: 12 });

  heading('Orders placed');
  row('Orders placed', String(summary.placed.total), { bold: true });
  row('Completed', String(summary.placed.completed), { indent: 12 });
  row('Still open (pending or accepted)', String(summary.placed.open), { indent: 12 });
  row('Cancelled', String(summary.placed.cancelled), { indent: 12 });
  row('Not paid yet (not cancelled)', `${summary.placed.unpaid}  (${money(summary.placed.unpaid_value)})`, { indent: 12 });

  if (summary.top_items.length > 0) {
    heading('Best sellers');
    for (const item of summary.top_items) row(`${item.quantity} x ${item.name}`.slice(0, 60), money(item.revenue), { indent: 12 });
  }

  // Order table.
  const cols = [
    ['No.', 36, 'left'],
    ['Placed', 74, 'left'],
    ['Paid', 74, 'left'],
    ['Table', 48, 'left'],
    ['Status', 62, 'left'],
    ['Payment', 90, 'left'],
    ['Total', 71, 'right'],
  ];
  const drawHeader = () => {
    const y = doc.y;
    let x = left;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444');
    for (const [label, w, align] of cols) {
      doc.text(label, x, y, { width: w, align });
      x += w;
    }
    doc.moveTo(left, y + 12).lineTo(right, y + 12).strokeColor('#999').stroke();
    doc.y = y + 16;
  };

  heading(`Orders (${orders.length})`);
  if (orders.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('No orders in this period.');
  } else {
    drawHeader();
    for (const o of orders) {
      if (doc.y + 14 > bottom()) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      const cells = [
        `#${o.id}`,
        when(o.created_at, vendor.timezone),
        when(o.paid_at, vendor.timezone),
        String(o.table_number).slice(0, 8),
        STATUS[o.status] ?? o.status,
        o.payment_status === 'paid' ? METHOD[o.payment_method] ?? 'Paid' : 'Unpaid',
        money(o.total),
      ];
      let x = left;
      doc.font('Helvetica').fontSize(8.5).fillColor(o.status === 'cancelled' ? '#888' : '#000');
      cols.forEach(([, w, align], i) => {
        doc.text(cells[i], x, y, { width: w - 4, align, lineBreak: false });
        x += w;
      });
      doc.y = y + 13;
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(8).fillColor('#999').text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width: right - left, align: 'center', lineBreak: false });
  }
  doc.end();
}
