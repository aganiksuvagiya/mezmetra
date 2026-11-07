import { useLayoutEffect, useRef } from 'react';
import { Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import CartPage from './pages/CartPage';
import Landing from './pages/Landing';
import MenuPage from './pages/MenuPage';
import NotFound from './pages/NotFound';
import OrderPage from './pages/OrderPage';
import TableLayout from './pages/TableLayout';

const positions = new Map(); // pathname -> scrollY, so Back returns to where the diner was in the menu

/** Scroll to the top on forward navigation; restore the old position on Back/Forward. */
function ScrollManager() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const current = useRef(pathname);

  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const onScroll = () => positions.set(current.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    current.current = pathname;
    window.scrollTo(0, type === 'POP' ? (positions.get(pathname) ?? 0) : 0);
  }, [pathname, type]);

  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <ScrollManager />
      {/* Phone-width column, centred; the darker canvas shows around it on larger screens. */}
      <div className="min-h-dvh bg-canvas">
        <div className="relative mx-auto min-h-dvh w-full max-w-md bg-page sm:shadow-column">
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/t/:token" element={<TableLayout />}>
              <Route index element={<MenuPage />} />
              <Route path="cart" element={<CartPage />} />
            </Route>
            <Route path="/o/:orderToken" element={<OrderPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </div>
    </ToastProvider>
  );
}
