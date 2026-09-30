import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Fail closed when the secret isn't configured.
 * Constant-time comparison; never logs the header.
 */
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
