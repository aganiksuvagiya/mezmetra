// What both bills agree on: the A4 PDF the server makes and the narrow printed bill the admin prints.

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

/**
 * The tax lines of a bill, as [{ label, amount }]. A restaurant with a GSTIN shows the tax as CGST and SGST halves; one without
 * shows it as one "Tax" line. The rate is named only when it gives this tax (the restaurant may have changed its rate since).
 * `orders` is how many orders are added up: each was rounded to a paisa by itself.
 */
export function taxLines({ subtotal, tax, orders = 1 }, { gstin, tax_percent: percent }) {
  const paise = Math.round(Number(tax) * 100);
  if (paise <= 0) return [];
  const rate = Number(percent);
  const fits = rate > 0 && Math.abs(Math.round((Math.round(Number(subtotal) * 100) * rate) / 100) - paise) <= orders - 1;
  if (!gstin) return [{ label: fits ? `Tax (${rate}%)` : 'Tax', amount: paise / 100 }];
  const half = Math.round(paise / 2);
  const part = fits ? ` ${Number((rate / 2).toFixed(3))}%` : '';
  return [
    { label: `CGST Output${part} (Excl)`, amount: half / 100 },
    { label: `SGST Output${part} (Excl)`, amount: (paise - half) / 100 },
  ];
}
