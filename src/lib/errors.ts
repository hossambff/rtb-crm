/**
 * Safe server-side error logging (QA-01). Drizzle wraps driver errors as "Failed query: <sql>\nparams: <values>" and
 * hides the real reason (timeout, pool, protocol) in `cause`. These helpers log a short request/ref id, the SQL text
 * WITHOUT params (params can hold personal data or secrets), and the driver cause (code + message), so a "Failed query"
 * 500 can be traced from the UI ("Ref …") to the log line.
 */

/** Short random reference shown to the user and written to the log line. */
export function errorRef(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Described = { name: string; message: string; code?: string; cause?: string; digest?: string };

/** Strip query params and trim — never log bound values. */
function scrub(message: string): string {
  return message.split(/\nparams:/)[0]!.replace(/\s+/g, " ").slice(0, 500);
}

export function describeError(e: unknown): Described {
  if (!(e instanceof Error)) return { name: "NonError", message: scrub(String(e)) };
  const out: Described = { name: e.name, message: scrub(e.message) };
  const any = e as Error & { code?: unknown; digest?: unknown; cause?: unknown };
  if (typeof any.code === "string") out.code = any.code;
  if (typeof any.digest === "string") out.digest = any.digest;
  const cause = any.cause;
  if (cause instanceof Error) {
    const c = cause as Error & { code?: unknown };
    out.cause = `${typeof c.code === "string" ? `${c.code} ` : ""}${scrub(c.message)}`;
  } else if (cause != null) out.cause = scrub(String(cause));
  return out;
}

/** Log one server error line with a ref id; returns the ref (show it to the user). */
export function logServerError(scope: string, e: unknown, ref: string = errorRef(), extra: Record<string, string | undefined> = {}): string {
  const d = describeError(e);
  const parts = [`[${scope}] ref=${ref}`, ...Object.entries(extra).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`), `${d.name}: ${d.message}`];
  if (d.code) parts.push(`code=${d.code}`);
  if (d.cause) parts.push(`cause=${d.cause}`);
  if (d.digest) parts.push(`digest=${d.digest}`);
  console.error(parts.join(" | "));
  return ref;
}
