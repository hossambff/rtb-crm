import { Skeleton } from "@/components/ui/misc";

export default function CallsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading calls">
      <Skeleton className="mb-2 h-9 w-40" />
      <Skeleton className="mb-6 h-4 w-96" />
      <div className="space-y-2 rounded-lg border border-border p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
