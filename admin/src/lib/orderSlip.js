// The order slip: a narrow paper ticket for the kitchen or counter, printed before the order is finished. It says what to make
// (dishes, quantities, extras, notes) and for which table, and carries no prices. It is printed by the browser, so any printer
// set up on the device works (an 80 mm or 58 mm receipt printer, or an ordinary one), and dish names in any script come out.

import { escapeHtml, printPage } from './print.js';

const KEY = 'mezmitra_order_slip';

/** Whether this device prints a slip for every new order by itself. */
export function readAutoSlip() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeAutoSlip(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice just lasts until the page is closed */
  }
}

const when = (date, timeZone) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(date));

function slip(order, { restaurant, timeZone }) {
  const dishes = (order.items ?? [])
    .map((item) => {
      const extras = (item.options ?? []).map((option) => `<p class="extra">+ ${escapeHtml(option.name)}</p>`).join('');
      const note = item.instructions ? `<p class="note">** ${escapeHtml(item.instructions)}</p>` : '';
      return `<li><span class="qty">${escapeHtml(item.quantity)} ×</span><div><p class="dish">${escapeHtml(item.name)}</p>${extras}${note}</div></li>`;
    })
    .join('');
  const count = (order.items ?? []).reduce((n, item) => n + item.quantity, 0);
  return `<article>
<h1>${escapeHtml(restaurant)}</h1>
<h2>ORDER SLIP</h2>
<div class="head"><strong>TABLE ${escapeHtml(order.table_number)}</strong><strong>#${escapeHtml(order.number)}</strong></div>
<p class="time">${escapeHtml(when(order.created_at, timeZone))}</p>
<ul>${dishes}</ul>
${order.note ? `<p class="order-note"><strong>NOTE:</strong> ${escapeHtml(order.note)}</p>` : ''}
<div class="foot"><span>Items: ${count}</span><strong>${order.payment_status === 'paid' ? 'PAID' : 'NOT PAID'}</strong></div>
</article>`;
}

/** A whole printable page holding one slip for each order. */
export function orderSlipDocument(orders, { restaurant = '', timeZone = 'Asia/Kolkata' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Order slip</title><style>
@page { margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 100%; max-width: 76mm; padding: 3mm; color: #000; background: #fff; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-wrap: anywhere; }
article { padding-bottom: 8mm; }
article + article { break-before: page; page-break-before: always; }
h1 { font-size: 17px; text-align: center; }
h2 { margin: 1mm 0 2mm; font-size: 12px; letter-spacing: 2px; text-align: center; }
.head { display: flex; justify-content: space-between; gap: 3mm; padding-top: 2mm; border-top: 2px solid #000; font-size: 21px; }
.time { padding-bottom: 2mm; border-bottom: 1px dashed #000; }
ul { list-style: none; }
li { display: flex; gap: 2mm; padding: 2mm 0; border-bottom: 1px dashed #000; break-inside: avoid; }
.qty { flex: none; min-width: 9mm; font-size: 17px; font-weight: 800; }
.dish { font-size: 17px; font-weight: 800; }
.extra { font-size: 14px; font-weight: 600; }
.note { font-size: 14px; font-weight: 800; font-style: italic; }
.order-note { padding: 2mm 0; border-bottom: 1px dashed #000; font-size: 14px; }
.foot { display: flex; justify-content: space-between; padding-top: 2mm; font-size: 14px; }
</style></head><body>${orders.map((order) => slip(order, { restaurant, timeZone })).join('')}</body></html>`;
}

/** Opens the device's print window with the slips. */
export const printOrderSlips = (orders, options) => orders.length > 0 && printPage(orderSlipDocument(orders, options), 'Order slip');
