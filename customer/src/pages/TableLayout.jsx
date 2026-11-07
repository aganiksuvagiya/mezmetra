import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import EmptyState from '../components/EmptyState';
import { Button, LinkButton } from '../components/Button';
import { AlertIcon, QrIcon } from '../components/Icons';
import { MenuSkeleton } from '../components/Skeleton';
import { Dock } from '../components/TabBar';
import { useToast } from '../components/Toast';
import { ApiError, errorMessage, getMenu, isAbort } from '../lib/api';
import { describeDropped, reconcileLines, useCart } from '../lib/cart';
import { TABLE_TOKEN_RE } from '../lib/ids';
import { applyTheme } from '../lib/theme';
import { usePageTitle } from '../lib/usePageTitle';

const STALE_AFTER_MS = 2 * 60_000;

/** Layout for /t/:token and /t/:token/cart: loads the menu once, owns the cart, draws the bottom bars. */
export default function TableLayout() {
  const { token } = useParams();
  // Re-mount per table so a different QR code never inherits another table's cart or menu.
  return <TableShell key={token} token={token} />;
}

function TableShell({ token }) {
  const toast = useToast();
  const cart = useCart(token);
  const { pathname } = useLocation();
  const { getLines, replace } = cart;
  const [state, setState] = useState({ status: 'loading' });
  const statusRef = useRef('loading');
  const lastLoaded = useRef(0);

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  // Dress the whole app in the restaurant's colours as soon as we know them.
  useEffect(() => {
    if (state.status === 'ready') applyTheme(state.menu.vendor.theme);
  }, [state]);

  /**
   * Fetch the menu and reconcile the cart with it (dishes switched off since they were added disappear).
   * `silent` keeps the current screen while refreshing. Resolves to { menu, dropped } or null.
   */
  const load = useCallback(
    async ({ silent = false, signal } = {}) => {
      if (!TABLE_TOKEN_RE.test(token)) {
        setState({ status: 'error', error: new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Table not found' }) });
        return null;
      }
      if (!silent) setState({ status: 'loading' });
      try {
        const menu = await getMenu(token, { signal });
        const result = reconcileLines(getLines(), menu.items);
        if (result.changed) replace(result.lines);
        lastLoaded.current = Date.now();
        setState({ status: 'ready', menu });
        return { menu, dropped: result.dropped };
      } catch (err) {
        if (isAbort(err) || signal?.aborted) return null;
        // A background refresh only takes over the screen when the table itself went away.
        if (!silent || err.status === 404 || err.status === 409) setState({ status: 'error', error: err });
        return null;
      }
    },
    [token, getLines, replace],
  );

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal }).then((result) => {
      if (result?.dropped.length) toast.info(describeDropped(result.dropped), { duration: 7000 });
    });
    return () => controller.abort();
  }, [load, toast]);

  // Coming back to a tab that has been in the background for a while: quietly check the menu is still current.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || statusRef.current !== 'ready') return;
      if (Date.now() - lastLoaded.current < STALE_AFTER_MS) return;
      load({ silent: true }).then((result) => {
        if (result?.dropped.length) toast.info(describeDropped(result.dropped), { duration: 7000 });
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load, toast]);

  const refreshMenu = useCallback(() => load({ silent: true }), [load]);
  const retry = useCallback(() => load(), [load]);

  usePageTitle(state.status === 'loading' ? 'Loading menu - MezMitra' : state.status === 'error' ? 'Menu unavailable - MezMitra' : undefined);

  if (state.status === 'loading') return <MenuSkeleton />;
  if (state.status === 'error') return <TableError error={state.error} onRetry={retry} />;

  const onMenu = pathname === `/t/${token}` || pathname === `/t/${token}/`;
  return (
    <>
      <Outlet context={{ token, menu: state.menu, cart, refreshMenu }} />
      {onMenu && <Dock token={token} count={cart.count} subtotalPaise={cart.subtotalPaise} />}
    </>
  );
}

function TableError({ error, onRetry }) {
  const status = error?.status;

  if (status === 404) {
    return (
      <main className="flex min-h-dvh flex-col justify-center">
        <EmptyState
          icon={<QrIcon className="size-8" />}
          tone="danger"
          title="This QR code isn't valid"
          action={
            <LinkButton to="/" block>
              Enter a table link
            </LinkButton>
          }
        >
          Ask a member of staff for help, or try scanning the code on your table again.
        </EmptyState>
      </main>
    );
  }

  if (status === 409) {
    return (
      <main className="flex min-h-dvh flex-col justify-center">
        <EmptyState
          icon={<AlertIcon className="size-8" />}
          title="This table isn't taking orders"
          action={
            <Button onClick={onRetry} variant="secondary" block>
              Try again
            </Button>
          }
        >
          {error.message}
        </EmptyState>
      </main>
    );
  }

  const offline = status === 0;
  return (
    <main className="flex min-h-dvh flex-col justify-center">
      <EmptyState
        icon={<AlertIcon className="size-8" />}
        tone="danger"
        title={offline ? "Can't reach the menu" : "The menu didn't load"}
        action={
          <Button onClick={onRetry} block>
            Retry
          </Button>
        }
      >
        {errorMessage(error)}
      </EmptyState>
    </main>
  );
}
