// Which ways of paying the product offers is decided by the server (PAYMENT_METHODS); the admin only shows those.
// `settings` is the response of GET /api/admin/payment-settings.

export const methodsAvailable = (settings) => new Set(settings?.methods_available ?? ['upi', 'cash', 'razorpay']);

/** True when diners have at least one way to pay, so the restaurant can take orders. */
export function canTakeOrders(settings) {
  if (!settings) return true; // unknown yet: do not nag
  const avail = methodsAvailable(settings);
  return (
    (avail.has('cash') && settings.cash_enabled) ||
    (avail.has('upi') && settings.upi_enabled && Boolean(settings.upi_id || settings.upi_mobile)) ||
    (avail.has('razorpay') && settings.razorpay_enabled && settings.razorpay_configured)
  );
}
