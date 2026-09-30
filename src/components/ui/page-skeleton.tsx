import { Skeleton } from "@/components/ui/misc";

/**
 * Shared route-level loading skeletons (loading.tsx). "detail" = record page, "dashboard" = KPI tiles + charts,
 * "form" = settings/admin sections.
 */
export function PageSkeleton({ variant, label }: { variant: "detail" | "dashboard" | "form"; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {variant === "dashboard" ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        </>
      ) : variant === "detail" ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Skeleton className="h-96" />
            <div className="space-y-4">
              <Skeleton className="h-40" />
              <Skeleton className="h-48" />
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-64" />
        </div>
      )}
    </div>
  );
}
