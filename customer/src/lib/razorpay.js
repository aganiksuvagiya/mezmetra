import { PaymentScriptError, scriptLoader } from './payScript';

export { PaymentScriptError };

/** Razorpay Checkout, loaded once on demand. */
export const loadRazorpay = scriptLoader('https://checkout.razorpay.com/v1/checkout.js', 'Razorpay');
