import type { Instrumentation } from "next";
import { logServerError } from "@/lib/errors";

/**
 * Server error surface (QA-01): every uncaught render / route / action error is logged once with a request ref
 * (the React digest when there is one — the same id error.tsx shows the user as "Ref …"), the route, and the driver
 * cause behind Drizzle's "Failed query" wrapper. Query params and headers are never logged.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  const hdr = request.headers["x-request-id"] ?? request.headers["x-vercel-id"];
  const requestId = Array.isArray(hdr) ? hdr[0] : hdr;
  logServerError("request-error", err, digest ?? requestId ?? undefined, {
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    type: context.routeType,
    requestId: requestId && requestId !== digest ? requestId : undefined,
  });
};
