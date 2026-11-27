// Which ways of paying the product offers is decided by the server (PAYMENT_METHODS); the admin only shows those.
// `settings` is the response of GET /api/admin/payment-settings.

export const methodsAvailable = (settings) => new Set(settings?.methods_available ?? ['cash', 'razorpay', 'phonepe']);

/** True when diners have at least one way to pay, so the restaurant can take orders. */
export function canTakeOrders(settings) {
  if (!settings) return true; // unknown yet: do not nag
  const avail = methodsAvailable(settings);
  return (
    (avail.has('cash') && settings.cash_enabled) ||
    (avail.has('razorpay') && settings.razorpay_enabled && settings.razorpay_configured) ||
    (avail.has('phonepe') && settings.phonepe_enabled && settings.phonepe_configured)
  );
}

// How a paid order was paid. Old orders can carry a way of paying that is no longer offered (UPI, Cashfree, Paytm).
export const METHOD_LABEL = {
  cash: 'Cash at counter',
  razorpay: 'Online (Razorpay)',
  phonepe: 'Online (PhonePe)',
  upi: 'UPI',
  cashfree: 'Online (Cashfree)',
  paytm: 'Online (Paytm)',
};

/** The short ending of a "Paid" label: " · Cash", " · UPI" or " · Online". */
export const paidVia = (method) => (method === 'cash' ? ' · Cash' : method === 'upi' ? ' · UPI' : method ? ' · Online' : '');
