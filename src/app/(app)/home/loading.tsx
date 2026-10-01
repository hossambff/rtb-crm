import { Skeleton } from "@/components/ui/misc";

export default function HomeLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading My Day">
      <Skeleton className="h-9 w-72 max-w-full" />
      <Skeleton className="h-[86px]" />
      <div className="grid gap-5 xl:grid-cols-5">
        <div className="space-y-2 rounded-lg border border-border p-5 xl:col-span-3">
          <Skeleton className="mb-4 h-6 w-24" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
        <div className="space-y-5 xl:col-span-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-48" />
        </div>
      </div>
    </div>
  );
}
