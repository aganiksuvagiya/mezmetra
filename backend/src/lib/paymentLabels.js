// How a paid order's method reads on receipts and reports. The last three are ways of paying the product no longer offers: orders
// that were paid with them still say how.
export const PAYMENT_LABELS = {
  cash: 'Cash',
  razorpay: 'Online (Razorpay)',
  phonepe: 'Online (PhonePe)',
  upi: 'UPI',
  cashfree: 'Online (Cashfree)',
  paytm: 'Online (Paytm)',
};

/** The ways of paying the product offers, in the order reports list them. */
export const PAYMENT_METHODS = ['cash', 'razorpay', 'phonepe'];

/** The current methods, plus any older one that appears in these paid amounts (so totals still add up). */
export const methodsFor = (seen) => [...PAYMENT_METHODS, ...[...new Set(seen)].filter((m) => m && !PAYMENT_METHODS.includes(m))];
