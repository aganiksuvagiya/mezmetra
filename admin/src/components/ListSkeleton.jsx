import { Skeleton } from './Spinner.jsx';

/** Placeholder rows shown while a list loads. */
export default function ListSkeleton({ rows = 5, label = 'Loading' }) {
  return (
    <ul role="status" aria-label={label} className="divide-y divide-slate-100">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="size-12 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
        </li>
      ))}
    </ul>
  );
}
