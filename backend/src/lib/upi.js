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

// MCC 5812: "Eating places and restaurants". A business (merchant) UPI ID is paid as a merchant, and the UPI apps want the
// merchant category code and a transaction reference in the link.
export const MERCHANT_CATEGORY_CODE = '5812';

/**
 * The query string of the payment link, e.g. `pa=...&pn=...&am=399.00&cu=INR&tn=...`.
 * The amount is computed here from the order, so a customer cannot change it. Clients prefix it with a
 * scheme: `upi://pay?` (any UPI app), `tez://upi/pay?` (Google Pay), `phonepe://pay?`, `paytmmp://pay?`.
 *
 * Two kinds of payee, and the apps treat them oppositely:
 *  - an ordinary (personal) UPI ID: deliberately minimal, because PhonePe/Google Pay refuse links for such IDs that carry
 *    merchant-only parameters (`tr`, `mc`, `url`);
 *  - a business (merchant) UPI ID (`merchant: true`): the link must carry the merchant category code (`mc`) and a transaction
 *    reference (`tr`, up to 35 letters/digits, one per order), otherwise Google Pay and PhonePe stop the payment with a
 *    "security reasons" message.
 */
export function upiQuery({ vpa, payeeName, amountPaise, note, merchant = false, reference = '' }) {
  const tr = String(reference).replace(/[^A-Za-z0-9]/g, '').slice(0, 35);
  return [
    `pa=${vpa}`, // already validated against VPA_RE, so '@' can stay readable
    `pn=${encodeURIComponent(cleanName(payeeName))}`,
    ...(merchant ? [`mc=${MERCHANT_CATEGORY_CODE}`, ...(tr ? [`tr=${tr}`] : [])] : []),
    `am=${(amountPaise / 100).toFixed(2)}`,
    'cu=INR',
    `tn=${encodeURIComponent(String(note).slice(0, 50))}`,
  ].join('&');
}
