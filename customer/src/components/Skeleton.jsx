export function Skeleton({ className = '', style }) {
  return <div aria-hidden="true" style={style} className={`rounded-xl bg-line/80 motion-safe:animate-pulse ${className}`} />;
}

export function MenuSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading menu">
      <span className="sr-only">Loading menu…</span>
      <div className="aurora px-5 pb-4 pt-6">
        <Skeleton className="h-9 w-28 rounded-full bg-white/80" />
        <Skeleton className="mt-6 h-9 w-56 bg-black/10" />
        <Skeleton className="mt-3 h-4 w-44 bg-black/10" />
        <Skeleton className="mt-5 h-[52px] w-full rounded-full bg-white/80" />
      </div>
      <div className="flex gap-2 px-4 py-3">
        {[96, 64, 88, 76].map((w, i) => (
          <Skeleton key={i} className="h-10 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <div className="px-4 pt-3">
        <Skeleton className="h-7 w-40" />
        <div className="mt-4 flex gap-3 overflow-hidden">
          <Skeleton className="aspect-[5/6] w-[68%] shrink-0 rounded-[28px]" />
          <Skeleton className="aspect-[5/6] w-[68%] shrink-0 rounded-[28px]" />
        </div>
        <div className="surface mt-8 divide-y divide-black/5 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4 p-4">
              <div className="flex-1 space-y-2 py-1">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="mt-3 h-5 w-16" />
              </div>
              <Skeleton className="size-[6.25rem] rounded-[22px]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OrderSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your order">
      <span className="sr-only">Loading your order…</span>
      <div className="aurora px-5 pb-4 pt-6">
        <Skeleton className="h-9 w-28 rounded-full bg-white/80" />
        <Skeleton className="mt-6 h-4 w-24 bg-black/10" />
        <Skeleton className="mt-2 h-9 w-52 bg-black/10" />
      </div>
      <div className="space-y-4 px-4 pt-1">
        <Skeleton className="surface h-40 bg-white" />
        <Skeleton className="surface h-56 bg-white" />
        <Skeleton className="surface h-28 bg-white" />
      </div>
    </div>
  );
}
