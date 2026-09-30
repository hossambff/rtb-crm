"use client";
import * as React from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * App-wide error boundary for every authenticated module (M-26): keeps the app shell (sidebar, topbar) and offers a
 * retry. Server errors arrive with a generic message + `digest`, which is the same ref the server logs
 * (src/instrumentation.ts), so a report can be matched to the log line.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-16 text-center">
      <p className="font-display text-xl text-fg">Something went wrong</p>
      <p className="mt-2 max-w-sm text-sm text-muted">
        This page couldn&apos;t load — often a brief database or network hiccup. Nothing was changed.
        {error.digest ? <span className="mt-1 block tabular">Ref {error.digest}</span> : null}
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={() => retry()}>
          <RotateCcw /> Try again
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/home">Go to My Day</Link>
        </Button>
      </div>
    </div>
  );
}
