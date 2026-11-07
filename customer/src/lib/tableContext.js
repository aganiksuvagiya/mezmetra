import { useOutletContext } from 'react-router-dom';

/** Context supplied by <TableLayout>: { token, menu, cart, refreshMenu }. */
export const useTable = () => useOutletContext();
