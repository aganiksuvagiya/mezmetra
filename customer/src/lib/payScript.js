// Loads a payment provider's checkout script once, on demand. A failed load (offline, blocked by an ad-blocker) is not cached,
// so the diner can simply tap "Pay online" again.

const LOAD_TIMEOUT_MS = 15_000;

export class PaymentScriptError extends Error {
  constructor() {
    super("We couldn't load the secure payment window. Check your connection and try again, or pay at the counter.");
    this.name = 'PaymentScriptError';
  }
}

/** Returns a function that loads `src` and resolves with `window[globalName]`. */
export function scriptLoader(src, globalName) {
  let loading = null;
  return function load() {
    if (typeof window === 'undefined') return Promise.reject(new PaymentScriptError());
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (loading) return loading;

    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok && window[globalName]) {
          resolve(window[globalName]);
        } else {
          script.remove();
          reject(new PaymentScriptError());
        }
      };
      const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
      script.src = src;
      script.async = true;
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    }).catch((err) => {
      loading = null;
      throw err;
    });

    return loading;
  };
}
