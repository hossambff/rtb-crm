import { Skeleton } from "@/components/ui/misc";

export default function MeetingBriefLoading() {
  return (
    <div className="mx-auto max-w-5xl" aria-busy="true" aria-label="Loading meeting brief">
      <Skeleton className="mb-3 h-3 w-16" />
      <Skeleton className="mb-2 h-9 w-72 max-w-full" />
      <Skeleton className="mb-6 h-4 w-56" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
