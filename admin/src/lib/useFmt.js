import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { formatClock, formatDateTime, formatMoney, formatTime } from './format.js';

/** Formatters bound to the signed-in vendor's time zone. */
export function useFmt() {
  const { vendor } = useAuth();
  const tz = vendor?.timezone;
  return useMemo(
    () => ({
      tz,
      money: formatMoney,
      dateTime: (value) => (value ? formatDateTime(value, tz) : '—'),
      time: (value) => (value ? formatTime(value, tz) : '—'),
      clock: (value) => (value ? formatClock(value, tz) : '—'),
    }),
    [tz],
  );
}
