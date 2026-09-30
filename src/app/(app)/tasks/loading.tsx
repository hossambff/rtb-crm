import { Skeleton } from "@/components/ui/misc";

export default function TasksLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading tasks">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-9 w-full max-w-xl" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}
