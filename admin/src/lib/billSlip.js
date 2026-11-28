// The bill on a narrow receipt printer (80 mm or 58 mm), laid out the way counter bills usually are: who sells, the memo number
// and time, product / quantity / rate / amount, the tax, the total in figures and words, and how it was paid.
import { amountInWords, taxLines } from '../../../shared/bill.js';
import { METHOD_LABEL } from './payments.js';
import { escapeHtml, printPage } from './print.js';

const plain = (rupees) => Number(rupees).toFixed(2);

function memoTime(date, timeZone) {
  const part = (options) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(date).map((p) => [p.type, p.value]));
  const t = part({ hour: '2-digit', minute: '2-digit', hour12: true });
  const d = part({ day: '2-digit', month: 'short', year: 'numeric' });
  return { time: `${t.hour}:${t.minute} ${t.dayPeriod}`, date: `${d.day}-${d.month}-${d.year}` };
}

/** The same dish with the same extras at the same price is one line, however many orders it came in. */
function billLines(items) {
  const lines = new Map();
  for (const item of items) {
    const extras = (item.options ?? []).map((o) => o.name);
    const rate = item.line_total / item.quantity; // the price of one, extras included
    const key = JSON.stringify([item.name, extras, rate.toFixed(4)]);
    const line = lines.get(key) ?? { name: item.name, extras, rate, quantity: 0, amount: 0 };
    line.quantity += item.quantity;
    line.amount += item.line_total;
    lines.set(key, line);
  }
  return [...lines.values()];
}

/** What the bill of a single paid order says. */
export const billOfOrder = (order) => ({
  numbers: [order.number],
  table: order.table_number,
  date: order.paid_at ?? order.created_at,
  items: order.items,
  subtotal: order.subtotal,
  tax: order.tax,
  total: order.total,
  paidBy: order.payment_status === 'paid' ? (order.payment_method ?? 'cash') : null,
});

/** What the bill of everything a table still has to pay says. `bill` is the answer of /api/admin/tables/:id/bill. */
export const billOfTable = (bill, now = new Date()) => ({
  numbers: bill.orders.map((o) => o.number),
  table: bill.table_number,
  date: now,
  items: bill.orders.flatMap((o) => o.items),
  subtotal: bill.subtotal,
  tax: bill.tax,
  total: bill.total,
  paidBy: null,
});

/** The printable page. `vendor` is the signed-in restaurant (its name, bill details, tax rate and time zone). */
export function billDocument(bill, vendor = {}) {
  const { time, date } = memoTime(new Date(bill.date), vendor.timezone || 'Asia/Kolkata');
  const head = [
    vendor.bill_address ? `<p>${escapeHtml(vendor.bill_address)}</p>` : '',
    vendor.gstin ? `<p>GSTIN: ${escapeHtml(vendor.gstin)}</p>` : '',
    vendor.fssai ? `<p>FSSAI: ${escapeHtml(vendor.fssai)}</p>` : '',
  ].join('');
  const rows = billLines(bill.items)
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}${line.extras.map((e) => `<div class="extra">*${escapeHtml(e)}</div>`).join('')}</td><td>${line.quantity}</td><td>${plain(line.rate)}</td><td>${plain(line.amount)}</td></tr>`,
    )
    .join('');
  const taxes = taxLines({ subtotal: bill.subtotal, tax: bill.tax, orders: bill.numbers.length }, vendor)
    .map((t) => `<div class="row"><span>${escapeHtml(t.label)}</span><span>${plain(t.amount)}</span></div>`)
    .join('');
  const quantity = bill.items.reduce((n, item) => n + item.quantity, 0);
  const pay = bill.paidBy
    ? `<div class="row"><span>Pay Mode: ${escapeHtml(METHOD_LABEL[bill.paidBy] ?? bill.paidBy)}</span><span>${plain(bill.total)}</span></div>`
    : '<div class="row"><strong>NOT PAID YET</strong></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${escapeHtml(bill.numbers.join(', '))}</title><style>
@page { margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 100%; max-width: 76mm; padding: 3mm 3mm 8mm; color: #000; background: #fff; font: 12px/1.4 ui-monospace, Menlo, Consolas, "Courier New", monospace; overflow-wrap: anywhere; }
header { text-align: center; }
h1 { font-size: 15px; line-height: 1.3; }
h2 { font-size: 13px; font-weight: 600; }
section { border-top: 1px dashed #000; padding: 1.5mm 0; }
.row { display: flex; justify-content: space-between; gap: 3mm; }
.row > span:last-child { flex: none; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.4mm 0 0.4mm 3mm; text-align: right; vertical-align: top; white-space: nowrap; }
th:first-child, td:first-child { width: 100%; padding-left: 0; text-align: left; white-space: normal; }
thead th { border-bottom: 1px dashed #000; padding-bottom: 1.5mm; }
tbody tr:first-child td { padding-top: 1.5mm; }
.extra { font-size: 11px; }
.total { display: flex; align-items: baseline; justify-content: space-between; gap: 2mm; font-weight: 700; }
.total b { font-size: 20px; }
footer { border-top: 1px dashed #000; padding-top: 2mm; }
</style></head><body>
<header><h1>${escapeHtml(vendor.bill_name || vendor.name || '')}</h1>${head}<h2>${vendor.gstin ? 'Tax Invoice' : 'Bill'}</h2></header>
<section><div class="row"><span>Memo# ${escapeHtml(bill.numbers.join(', '))}</span><span>${time}&nbsp; ${date}</span></div><div>Table: ${escapeHtml(bill.table)}</div></section>
<section><table><thead><tr><th>Product</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><div class="row"><span>Sub Total</span><span>${plain(bill.subtotal)}</span></div>${taxes}</section>
<section><div class="total"><span>Total Qty: ${quantity}&nbsp; Amt:</span><b>${plain(bill.total)}</b></div><p>(${amountInWords(bill.total)})</p>${pay}</section>
<footer><p>Thank you, please visit again... <span style="white-space:nowrap">E &amp; OE</span></p>${vendor.bill_contact ? `<p>For any feedback/query, please contact us on ${escapeHtml(vendor.bill_contact)}</p>` : ''}</footer>
</body></html>`;
}

export const printBill = (bill, vendor) => printPage(billDocument(bill, vendor), 'Bill');
