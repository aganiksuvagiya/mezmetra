import PDFDocument from 'pdfkit';

// The built-in PDF fonts have no rupee glyph, so amounts are printed as "Rs 399.00".
const money = (rupees) => `Rs ${Number(rupees).toFixed(2)}`;

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(date));
}

/**
 * Stream a receipt PDF for an order into `res` (anything writable).
 * `order` is the admin serialisation (see serialize.adminOrderOut).
 */
export function writeReceipt(res, { vendor, order }) {
  const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `Receipt #${order.id}` } });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(18).text(vendor.name, { align: 'center' });
  doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#666').text('Payment receipt', { align: 'center' });
  doc.moveDown(0.8).fillColor('#000').fontSize(10);

  const meta = [
    ['Receipt no.', `#${order.id}`],
    ['Table', order.table_number],
    ['Date', formatDate(order.paid_at ?? order.created_at, vendor.timezone)],
    ['Payment', `${{ razorpay: 'Online (Razorpay)', cashfree: 'Online (Cashfree)', upi: 'UPI' }[order.payment_method] ?? 'Cash'} - ${order.payment_status.toUpperCase()}`],
  ];
  for (const [label, value] of meta) {
    const y = doc.y;
    doc.font('Helvetica').fillColor('#666').text(label, 36, y, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#000').text(String(value), 130, y);
  }

  doc.moveDown(0.8);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.5);

  for (const item of order.items) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(`${item.quantity} x ${item.name}`, left, y, { width: right - left - 70 });
    doc.font('Helvetica-Bold').text(money(item.line_total), right - 70, y, { width: 70, align: 'right' });
    for (const opt of item.options) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(`  + ${opt.name}${opt.price ? ` (${money(opt.price)})` : ''}`, left);
    }
    if (item.instructions) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#666').text(`  Note: ${item.instructions}`, left);
    doc.moveDown(0.3);
  }

  doc.moveDown(0.2).moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.5).fontSize(10).fillColor('#000');

  const line = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, left, y, { width: 120 });
    doc.text(money(value), right - 100, y, { width: 100, align: 'right' });
  };
  line('Subtotal', order.subtotal);
  if (order.tax > 0) line('Tax', order.tax);
  doc.moveDown(0.2);
  line('Total', order.total, true);

  doc.moveDown(1.5).font('Helvetica').fontSize(9).fillColor('#666').text('Thank you! Visit again.', { align: 'center' });
  doc.end();
}
