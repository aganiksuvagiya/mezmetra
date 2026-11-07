import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import { Button } from './components/Button.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { LoadingBlock } from './components/Spinner.jsx';
import { ErrorState } from './components/EmptyState.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { useDocumentTitle } from './lib/hooks.js';
import Categories from './pages/Categories.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Items from './pages/Items.jsx';
import Login from './pages/Login.jsx';
import Orders from './pages/Orders.jsx';
import Payments from './pages/Payments.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Platform from './pages/Platform.jsx';
import Reports from './pages/Reports.jsx';
import QrCodes from './pages/QrCodes.jsx';
import Appearance from './pages/Appearance.jsx';
import Settings from './pages/Settings.jsx';
import Signup from './pages/Signup.jsx';
import Tables from './pages/Tables.jsx';

function FullScreen({ children }) {
  return <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">{children}</div>;
}

/** Redirects to /login (remembering where the person was going) unless a session is active. */
function RequireAuth({ children }) {
  const { status, error, retry, logout } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <FullScreen>
        <LoadingBlock label="Loading your restaurant…" />
      </FullScreen>
    );
  }
  if (status === 'error') {
    return (
      <FullScreen>
        <div className="rounded-xl border border-slate-200 bg-white shadow-xs">
          {error?.code === 'ACCOUNT_SUSPENDED' ? (
            <ErrorState title="Account suspended" error={error} />
          ) : (
            <ErrorState title="Can't load your account" error={error} onRetry={retry} />
          )}
          <div className="border-t border-slate-100 p-3 text-center">
            <Button variant="ghost" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </FullScreen>
    );
  }
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
}

/** Login/signup are only for signed-out visitors; a signed-in visitor is sent on to the app. */
function GuestOnly({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <FullScreen>
        <LoadingBlock label="Loading…" />
      </FullScreen>
    );
  }
  if (status === 'authed') {
    const from = location.state?.from;
    return <Navigate to={typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'} replace />;
  }
  return children;
}

function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="rounded-xl border border-slate-200 bg-white py-16 text-center shadow-xs">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500">That page doesn&rsquo;t exist or has moved.</p>
      <Link to="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
        Back to dashboard
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
            <Route path="/signup" element={<GuestOnly><Signup /></GuestOnly>} />
            <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
            <Route path="/reset-password" element={<GuestOnly><ResetPassword /></GuestOnly>} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="menu" element={<Navigate to="/menu/items" replace />} />
              <Route path="menu/categories" element={<Categories />} />
              <Route path="menu/items" element={<Items />} />
              <Route path="tables" element={<Tables />} />
              <Route path="tables/qr" element={<QrCodes />} />
              <Route path="orders" element={<Orders />} />
              <Route path="payments" element={<Payments />} />
              <Route path="reports" element={<Reports />} />
              <Route path="appearance" element={<Appearance />} />
              <Route path="platform" element={<Platform />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
