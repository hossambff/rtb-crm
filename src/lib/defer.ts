import "server-only";
import { after } from "next/server";
import { outsideTransaction } from "@/db";
import { logServerError } from "@/lib/errors";

/**
 * Run `fn` after the response (serverless-safe `after()`), outside any surrounding transaction's async context (CR L1),
 * so its queries go through the pool limiter once the transaction has committed. Outside a request scope (scripts,
 * tests) it runs best-effort right away. Never throws; errors are logged under `label`.
 */
export function defer(label: string, fn: () => Promise<unknown>): void {
  const run = () => outsideTransaction(() => fn().catch((e) => logServerError(label, e)));
  try {
    after(run);
  } catch {
    void run();
  }
}
