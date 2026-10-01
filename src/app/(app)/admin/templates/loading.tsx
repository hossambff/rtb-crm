import { Skeleton } from "@/components/ui/misc";

export default function TemplatesLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading templates">
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}
