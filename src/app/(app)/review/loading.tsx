import { Skeleton } from "@/components/ui/misc";

export default function ReviewLoading() {
  return (
    <div aria-busy="true" aria-label="Building the exception list">
      <Skeleton className="mb-2 h-9 w-56" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <Skeleton className="mb-5 h-24 w-full" />
      <div className="space-y-2 rounded-lg border border-border p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}
