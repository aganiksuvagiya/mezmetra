import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Lets a page dock a fixed side panel against the right edge of the screen and have the whole app shell make room for it
 * (the page shrinks instead of the panel floating over it). A page calls useReserveSidePanelSpace(true) while its panel is shown;
 * the shell reads `open` and pads its content on the right by the panel's width.
 */
const SidePanelContext = createContext({ open: false, reserve: () => () => {} });

export function SidePanelProvider({ children }) {
  const [count, setCount] = useState(0);
  const reserve = useCallback(() => {
    setCount((c) => c + 1);
    return () => setCount((c) => c - 1);
  }, []);
  const value = useMemo(() => ({ open: count > 0, reserve }), [count, reserve]);
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
