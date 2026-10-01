import { Skeleton } from "@/components/ui/misc";

/** Settings loads six things in parallel (QA: missing loading state). */
export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-48" />
      ))}
    </div>
  );
}
