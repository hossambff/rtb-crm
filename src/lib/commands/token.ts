import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { UserError } from "@/lib/actions";

/**
 * Signed, short-lived command tokens. A preview issues one describing exactly what will run (verb, target, record ids);
 * execute/undo accept only a valid token for the same user — so nothing runs without a preview, and the browser can't
 * widen a command after the user saw it (it may only drop records). Stateless: HMAC-SHA256 over the JSON payload.
 */
const TTL_MS = 15 * 60_000;

function secret(): string {
  const k = process.env.BETTER_AUTH_SECRET || process.env.ENCRYPTION_KEY;
  if (!k) throw new Error("No signing secret configured for command tokens");
  return `rso-command:${k}`;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function signToken<T extends object>(userId: string, kind: "run" | "undo", payload: T, ttlMs = TTL_MS): string {
  const body = b64(JSON.stringify({ u: userId, k: kind, exp: Date.now() + ttlMs, p: payload }));
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T>(token: string, userId: string, kind: "run" | "undo"): T {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new UserError("This preview is no longer valid — run the command again.");
  const want = createHmac("sha256", secret()).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new UserError("This preview is no longer valid — run the command again.");
  let parsed: { u: string; k: string; exp: number; p: T };
  try {
    parsed = JSON.parse(unb64(body));
  } catch {
    throw new UserError("This preview is no longer valid — run the command again.");
  }
  if (parsed.u !== userId || parsed.k !== kind) throw new UserError("This preview belongs to another session.");
  if (Date.now() > parsed.exp) throw new UserError(kind === "undo" ? "Undo has expired (15 minutes)." : "This preview expired — run the command again.");
  return parsed.p;
}
