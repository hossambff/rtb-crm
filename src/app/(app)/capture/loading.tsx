import { Skeleton } from "@/components/ui/misc";

export default function CaptureLoading() {
  return (
    <div className="mx-auto max-w-2xl" aria-busy="true" aria-label="Loading capture">
      <Skeleton className="mb-2 h-9 w-40" />
      <Skeleton className="mb-6 h-4 w-72 max-w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
