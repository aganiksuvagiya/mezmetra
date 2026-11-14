import { scriptLoader } from './payScript';

/** Cashfree's checkout script (global `Cashfree`), loaded once on demand. */
export const loadCashfree = scriptLoader('https://sdk.cashfree.com/js/v3/cashfree.js', 'Cashfree');
