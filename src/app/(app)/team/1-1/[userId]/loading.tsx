import { Skeleton } from "@/components/ui/misc";

export default function OneOnOneLoading() {
  return (
    <div aria-busy="true" aria-label="Preparing the 1:1 brief">
      <Skeleton className="mb-4 h-3 w-20" />
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
      <div className="rounded-lg border border-border p-5">
        <Skeleton className="h-4 w-2/3" />
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">Pulling the week together…</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
