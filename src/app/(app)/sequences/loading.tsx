import { Skeleton } from "@/components/ui/misc";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading sequences">
      <Skeleton className="mb-2 h-9 w-44" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
