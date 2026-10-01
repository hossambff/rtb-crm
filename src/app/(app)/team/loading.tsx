import { Skeleton } from "@/components/ui/misc";

export default function TeamLoading() {
  return (
    <div aria-busy="true" aria-label="Loading team feed">
      <Skeleton className="mb-2 h-9 w-32" />
      <Skeleton className="mb-6 h-4 w-72 max-w-full" />
      <Skeleton className="mb-5 h-9 w-64" />
      <div className="mx-auto max-w-2xl space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-lg border border-border p-5">
            <div className="flex gap-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="mt-4 h-12 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
