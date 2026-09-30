import { Skeleton } from "@/components/ui/misc";

export default function InboxLoading() {
  return (
    <div aria-busy="true" aria-label="Loading inbox">
      <Skeleton className="mb-2 h-9 w-40" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <div className="mb-4 flex gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(320px,400px)_1fr]">
        <div className="space-y-3 rounded-lg border border-border p-4">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="hidden h-96 w-full xl:block" />
      </div>
    </div>
  );
}
