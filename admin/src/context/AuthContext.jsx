import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onUnauthorized } from '../lib/api.js';
import { auth } from '../lib/auth.js';

export const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

/**
 * Owns the signed-in vendor (including its time zone, which every date in the app is rendered in).
 * status: 'loading' (checking a stored token) | 'authed' | 'anon' | 'error' (could not reach the API).
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState(() => ({
    status: auth.getToken() ? 'loading' : 'anon',
    vendor: null,
    error: null,
    expired: false,
  }));

  // Any 401 from the API lands here (api.js has already cleared the token).
  useEffect(
    () => onUnauthorized(() => setState({ status: 'anon', vendor: null, error: null, expired: true })),
    [],
  );

  const loadMe = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const vendor = await api('/api/auth/me');
      setState({ status: 'authed', vendor, error: null, expired: false });
    } catch (error) {
      if (error.status === 401) return; // handled by onUnauthorized
      setState((s) => ({ ...s, status: 'error', error }));
    }
  }, []);

  useEffect(() => {
    if (auth.getToken()) loadMe();
  }, [loadMe]);

  const startSession = useCallback(async (path, body) => {
    const { token, vendor } = await api(path, { method: 'POST', body, auth: false });
    auth.setToken(token);
    setState({ status: 'authed', vendor, error: null, expired: false });
  }, []);

  const value = useMemo(
    () => ({
      status: state.status,
      vendor: state.vendor,
      error: state.error,
      expired: state.expired,
      login: (email, password) => startSession('/api/auth/login', { email, password }),
      signup: (name, email, password) => startSession('/api/auth/signup', { name, email, password }),
      logout: () => {
        auth.clear();
        setState({ status: 'anon', vendor: null, error: null, expired: false });
      },
      updateVendor: (vendor) => setState((s) => ({ ...s, vendor })),
      retry: loadMe,
    }),
    [state, startSession, loadMe],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
