"use client";
import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shared error state for analytics/admin segments (transient DB errors should be retryable, never a blank page). */
export function SegmentError({ error, retry, what }: { error: Error & { digest?: string }; retry: () => void; what: string }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
      <p className="font-display text-lg text-fg">Couldn&apos;t load {what}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">The data source didn&apos;t respond in time. Nothing was changed. {error.digest ? `Ref ${error.digest}.` : ""}</p>
      <Button className="mt-4" onClick={() => retry()}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
