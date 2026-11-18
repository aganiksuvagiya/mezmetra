import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Lets a page dock a fixed side panel against the right edge of the screen and have the whole app shell make room for it
 * (the page shrinks instead of the panel floating over it). A page calls useReserveSidePanelSpace(true) while its panel is shown;
 * the shell reads `open` and pads its content on the right by the panel's width.
 */
const SidePanelContext = createContext({ open: false, reserve: () => () => {}, notificationsOpen: false, setNotificationsOpen: () => {} });

export function SidePanelProvider({ children }) {
  const [count, setCount] = useState(0);
  // The bell's notification panel and a page's detail panel (an order) share the right edge, so only one shows at a time:
  // the shell opens/closes this one and the Orders page closes its order when it opens (and the other way round).
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const reserve = useCallback(() => {
    setCount((c) => c + 1);
    return () => setCount((c) => c - 1);
  }, []);
  const value = useMemo(() => ({ open: count > 0, reserve, notificationsOpen, setNotificationsOpen }), [count, reserve, notificationsOpen]);
  return <SidePanelContext value={value}>{children}</SidePanelContext>;
}

export const useSidePanelSpace = () => useContext(SidePanelContext);

/** Reserve room for a docked side panel for as long as `active` is true. */
export function useReserveSidePanelSpace(active) {
  const { reserve } = useContext(SidePanelContext);
  useEffect(() => {
    if (!active) return undefined;
    return reserve();
  }, [active, reserve]);
}
