import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading accounts">
      <Skeleton className="mb-2 h-9 w-48" />
      <Skeleton className="mb-6 h-4 w-72 max-w-full" />
      <div className="mb-3 flex gap-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="space-y-px rounded-lg border border-border">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-none" />
        ))}
      </div>
    </div>
  );
}
