import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBlob } from './api.js';

export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · MezMitra Admin` : 'MezMitra Admin';
  }, [title]);
}

export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Runs an async action while exposing `busy`, and ignores re-entrant calls (so a double click cannot submit twice,
 * even before React re-renders the disabled button).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = useCallback(async (fn) => {
    if (lock.current) return undefined;
    lock.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  return [run, busy];
}

/**
 * Data fetching with the behaviours every list in this app needs:
 *  - when `deps` change the old data is dropped immediately - even in the very render where the change happens, so a
 *    new filter never paints the previous filter's rows - and `loading` is true until the new data lands;
 *  - `reload()` / polling refetch in the background and keep the current data on screen until the new data lands;
 *  - a background failure keeps the last good data and sets `error` (with `updatedAt` telling how old it is);
 *  - responses from superseded requests are ignored;
 *  - polling pauses while the tab is hidden (unless `pollInBackground`) and refreshes as soon as it becomes visible again.
 * `deps` must be primitives (they are compared through JSON).
 *
 * Returns { data, error, loading, refreshing, updatedAt, reload, setData }.
 */
export function useQuery(fetcher, deps = [], { interval = 0, enabled = true, pollInBackground = false } = {}) {
  const sig = JSON.stringify(deps);
  const sigRef = useRef(sig);
  const [state, setState] = useState({ sig, data: undefined, error: null, loading: enabled, refreshing: false, updatedAt: null });
  const fetcherRef = useRef(fetcher);
  const seq = useRef(0);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  // mode: 'initial' (state was just reset), 'reload' (user/mutation) or 'poll' (timer).
  const load = useCallback(async (mode) => {
    const id = ++seq.current;
    const forSig = sigRef.current;
    if (mode === 'reload') {
      // With data on screen this is a quiet refresh; after a failed first load it is a visible retry.
      setState((s) => (s.data === undefined ? { ...s, loading: true, error: null } : { ...s, refreshing: true }));
    } else if (mode === 'poll') {
      setState((s) => ({ ...s, refreshing: true }));
    }
    try {
      const data = await fetcherRef.current();
      if (id !== seq.current) return;
      setState({ sig: forSig, data, error: null, loading: false, refreshing: false, updatedAt: new Date() });
    } catch (error) {
      if (id !== seq.current) return;
      if (error?.name === 'AbortError') return;
      setState((s) => ({ ...s, sig: forSig, error, loading: false, refreshing: false }));
    }
  }, []);

  // (Re)load whenever the inputs change, starting from a clean slate.
  useEffect(() => {
    if (!enabled) return undefined;
    sigRef.current = sig;
    setState({ sig, data: undefined, error: null, loading: true, refreshing: false, updatedAt: null });
    load('initial');
    return () => {
      seq.current += 1; // invalidate anything still in flight for the old inputs
    };
  }, [enabled, load, sig]);

  // Polling.
  useEffect(() => {
    if (!interval || !enabled) return undefined;
    const tick = () => {
      if (pollInBackground || document.visibilityState === 'visible') load('poll');
    };
    const timer = setInterval(tick, interval);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [interval, enabled, pollInBackground, load]);

  const reload = useCallback(() => load('reload'), [load]);
  // Replaces the data (for example with a mutation's response). Requests already in flight were issued before this
  // change, so they are discarded rather than allowed to overwrite it with older data.
  const setData = useCallback((next) => {
    seq.current += 1;
    setState((s) => ({ ...s, data: typeof next === 'function' ? next(s.data) : next, error: null, loading: false, refreshing: false }));
  }, []);

  // Inputs changed but the reset effect has not run yet: present an empty, loading state right now.
  if (state.sig !== sig) {
    return { data: undefined, error: null, loading: true, refreshing: false, updatedAt: null, reload, setData };
  }
  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, updatedAt: state.updatedAt, reload, setData };
}

/**
 * Fetches an authenticated binary (QR png ...) and exposes it as a blob URL for <img>/<a download>.
 * The URL is revoked when the path changes or the component unmounts.
 */
export function useBlobUrl(path, enabled = true) {
  const [state, setState] = useState({ url: null, error: null, loading: enabled });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !path) return undefined;
    let cancelled = false;
    let objectUrl = null;
    setState({ url: null, error: null, loading: true });
    apiBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, error: null, loading: false });
      })
      .catch((error) => {
        if (!cancelled) setState({ url: null, error, loading: false });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** If the current page no longer exists (for example the last row on it was deleted), move to the last real page. */
export function useClampPage(page, total, perPage, setPage, ready) {
  useEffect(() => {
    if (!ready) return;
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page > last) setPage(last);
  }, [page, total, perPage, setPage, ready]);
}

/** Saves a blob under a file name (used for QR PNGs fetched with the auth header). */
export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
