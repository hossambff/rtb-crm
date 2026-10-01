import "server-only";
import { NextResponse } from "next/server";
import { getSigningSecret } from "./config";
import { ReplayGuard, verifySlackSignature } from "./core";

const MAX_BODY_BYTES = 64 * 1024;
const g = globalThis as unknown as { __slackReplay?: ReplayGuard };
const replay: ReplayGuard = g.__slackReplay ?? (g.__slackReplay = new ReplayGuard());

/**
 * Authenticate an inbound Slack request (interactivity, slash commands). Order matters:
 * size cap → signature over the exact raw bytes (v0, 5-minute window, constant-time) → replay guard.
 * Nothing in the body is trusted or parsed before the signature checks out.
 */
export async function readVerifiedSlackRequest(req: Request): Promise<{ ok: true; form: URLSearchParams; teamId: string | null } | { ok: false; res: Response }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return { ok: false, res: NextResponse.json({ error: "too large" }, { status: 413 }) };
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false, res: NextResponse.json({ error: "too large" }, { status: 413 }) };
  const cfg = await getSigningSecret();
  // Not configured: behave as if the endpoint did not exist (no oracle for probing).
  if (!cfg) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
  const signature = req.headers.get("x-slack-signature");
  const check = verifySlackSignature({ signingSecret: cfg.signingSecret, timestamp: req.headers.get("x-slack-request-timestamp"), signature, rawBody: raw });
  if (!check.ok) return { ok: false, res: NextResponse.json({ error: "invalid signature" }, { status: 401 }) };
  if (!replay.firstSeen(signature!)) return { ok: false, res: new NextResponse(null, { status: 200 }) }; // replay: ack, do nothing
  return { ok: true, form: new URLSearchParams(raw), teamId: cfg.teamId };
}

export const ephemeral = (text: string) => NextResponse.json({ response_type: "ephemeral", text });
