import { Skeleton } from "@/components/ui/misc";

/** Board skeleton (streams while the board data loads; the saved-view redirect happens before it — QA B8). */
export function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading board">
      <div className="mb-5 flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-10 w-80 max-w-full" />
      </div>
      <Skeleton className="mb-4 h-8 w-full max-w-3xl" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-[272px] shrink-0 space-y-2">
            <Skeleton className="h-16 w-full" />
            {Array.from({ length: 4 - (i % 3) }).map((__, j) => (
              <Skeleton key={j} className="h-28 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
