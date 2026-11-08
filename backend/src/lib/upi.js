// UPI deep-link helpers (NPCI "upi://pay" intent).

// handle@bank, e.g. name@okhdfcbank, 9876543210@ybl
export const VPA_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;

// UPI transaction references (UTR) are normally 12 digits; some apps show letters too.
export const UPI_REFERENCE_RE = /^[A-Za-z0-9]{6,30}$/;

const cleanName = (name) =>
  String(name)
    .replace(/[^\p{L}\p{N} .&'-]/gu, '')
    .trim()
    .slice(0, 40) || 'Restaurant';

/**
 * The query string of the payment link, e.g. `pa=...&pn=...&am=399.00&cu=INR&tn=...`.
 * The amount is computed here from the order, so a customer cannot change it. Clients prefix it with a
 * scheme: `upi://pay?` (any UPI app), `tez://upi/pay?` (Google Pay), `phonepe://pay?`, `paytmmp://pay?`.
 *
 * Deliberately minimal: apps such as PhonePe/Google Pay refuse links for ordinary (non-merchant) UPI IDs that
 * carry merchant-only parameters (`tr`, `mc`, `url`), so only the universally accepted ones are sent.
 */
export function upiQuery({ vpa, payeeName, amountPaise, note }) {
  return [
    `pa=${vpa}`, // already validated against VPA_RE, so '@' can stay readable
    `pn=${encodeURIComponent(cleanName(payeeName))}`,
    `am=${(amountPaise / 100).toFixed(2)}`,
    'cu=INR',
    `tn=${encodeURIComponent(String(note).slice(0, 50))}`,
  ].join('&');
}
