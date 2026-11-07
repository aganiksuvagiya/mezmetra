// The only place that knows where the session token lives.
const KEY = 'mezmitra_admin_token';

export const auth = {
  getToken() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  setToken(token) {
    try {
      localStorage.setItem(KEY, token);
    } catch {
      /* storage unavailable (private mode): the session just will not survive a reload */
    }
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};
