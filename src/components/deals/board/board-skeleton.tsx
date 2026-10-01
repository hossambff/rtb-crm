import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { KANBAN_COL_W } from "./layout";

/** Board skeleton (streams while the board data loads; the saved-view redirect happens before it — QA B8). */
export function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading board" className="min-w-0 max-w-full overflow-hidden">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-64 max-w-full" />
        </div>
        <Skeleton className="h-10 w-80 max-w-full" />
      </div>
      <Skeleton className="mb-4 h-8 w-full max-w-3xl" />
      {/* Same scroller geometry as the live board so nothing spills outside the page on phones. */}
      <div className="-mx-4 flex gap-3 overflow-hidden px-4 sm:-mx-6 sm:px-6 md:-mx-8 md:px-8">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={cn(KANBAN_COL_W, "shrink-0 space-y-2")}>
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
