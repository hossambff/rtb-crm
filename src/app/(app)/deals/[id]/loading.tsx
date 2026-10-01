import { Skeleton } from "@/components/ui/misc";

/** Mirrors the summary-first layout (V2 §B6) so the page doesn't jump when it streams in. */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading deal">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-80 max-w-full" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="h-8 w-full" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Skeleton className="order-2 h-28 lg:order-1" />
        <Skeleton className="order-1 h-28 lg:order-2" />
        <Skeleton className="order-3 h-16 lg:col-span-2" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-96" />
    </div>
  );
}
