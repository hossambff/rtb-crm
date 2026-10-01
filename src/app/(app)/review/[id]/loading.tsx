import { Skeleton } from "@/components/ui/misc";

export default function ReviewSessionLoading() {
  return (
    <div className="fixed inset-0 z-40 bg-bg" aria-busy="true" aria-label="Loading the review">
      <div className="border-b border-border px-4 py-3 md:px-8">
        <Skeleton className="mx-auto h-6 max-w-5xl" />
      </div>
      <div className="mx-auto max-w-5xl space-y-4 px-4 pt-8 md:px-8">
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-4 lg:grid-cols-5">
          <Skeleton className="h-40 lg:col-span-3" />
          <Skeleton className="h-40 lg:col-span-2" />
        </div>
      </div>
    </div>
  );
}
