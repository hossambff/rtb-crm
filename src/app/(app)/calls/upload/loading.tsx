import { Skeleton } from "@/components/ui/misc";

export default function UploadLoading() {
  return (
    <div className="mx-auto max-w-3xl" aria-busy="true" aria-label="Loading upload">
      <Skeleton className="mb-2 h-9 w-56" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
