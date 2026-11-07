// Tiny CSV writer for spreadsheet exports (Excel, Google Sheets).

/**
 * One cell. Text that starts with = + - @ (or a tab / carriage return) would be run as a formula by a spreadsheet, so it
 * gets a leading apostrophe; dish names and table numbers are typed by restaurants and must never execute anything.
 * Numbers are written as plain numbers.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows (arrays) to CSV text: CRLF line ends and a byte-order mark so Excel reads UTF-8 (₹, Gujarati ...) correctly. */
export function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
