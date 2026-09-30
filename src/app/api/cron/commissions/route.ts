import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { accrueCommissions } from "@/lib/commissions/engine";

/**
 * Daily commission accrual run (PRD M18): accrues new earnings from won deals / activations, clawbacks, and expires
 * lapsed lead registrations. Idempotent + serialized by an advisory lock (safe alongside the "Run accruals" button).
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const result = await accrueCommissions({ actorId: null });
  return Response.json({ ok: true, ...result });
}
