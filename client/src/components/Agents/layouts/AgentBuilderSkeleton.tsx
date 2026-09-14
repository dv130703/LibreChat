import { Skeleton } from '@librechat/client';

export default function AgentBuilderSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {/* HEADER — agent switcher + toolbar actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-light pb-4">
        <Skeleton className="h-9 w-64 rounded-xl" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24 rounded-xl" />
          <Skeleton className="h-9 w-24 rounded-xl" />
        </div>
      </div>

      {/* TABS */}
      <div className="flex gap-4 border-b border-border-light pb-2">
        <Skeleton className="h-6 w-20 rounded" />
        <Skeleton className="h-6 w-16 rounded" />
        <Skeleton className="h-6 w-20 rounded" />
      </div>

      {/* BODY — two columns */}
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-16 w-16 flex-shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-9 w-full rounded-xl" />
              <Skeleton className="h-9 w-full rounded-xl" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-9 w-full rounded-xl" />
            <Skeleton className="h-9 w-full rounded-xl" />
          </div>
        </div>
        <Skeleton className="h-[140px] w-full rounded-xl" />
      </div>

      {/* TOOLS */}
      <div className="flex flex-col gap-1.5">
        <Skeleton className="mb-1 h-3 w-16 rounded" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    </div>
  );
}
