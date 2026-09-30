"use client";
import * as React from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/actions";

/** Run a server action in a transition; toast errors (and optional success). Returns [run, pending]. */
export function useRun() {
  const [pending, start] = React.useTransition();
  const run = React.useCallback(
    <T,>(fn: () => Promise<ActionResult<T>>, opts: { success?: string | ((data: T) => string); onOk?: (data: T) => void; onError?: (r: { error: string; fieldErrors?: Record<string, string[]> }) => void } = {}) =>
      start(async () => {
        const r = await fn();
        if (!r.ok) {
          toast.error(r.error);
          opts.onError?.(r);
          return;
        }
        if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r.data) : opts.success);
        opts.onOk?.(r.data);
      }),
    [],
  );
  return [run, pending] as const;
}
