/**
 * Executive help requests (V2 §C6) — pure, client-safe, unit tested.
 * "Need Hossam on the TheStreet call Thursday": a tracked ask to an exec/leader with a needed-by date. The target
 * accepts / declines / marks done with a response; open asks past needed-by come back to the requester.
 */
import { z } from "zod";

export const HELP_STATUSES = ["open", "accepted", "declined", "done", "cancelled"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];
export const HELP_STATUS_LABEL: Record<HelpStatus, string> = { open: "Waiting", accepted: "Accepted", declined: "Declined", done: "Done", cancelled: "Withdrawn" };

export const helpAskSchema = z.string().trim().min(10, "Say what you need (at least 10 characters)").max(1000);

/** Allowed target responses from a given status. */
export function canTransition(from: string, to: "accepted" | "declined" | "done"): boolean {
  if (from === "open") return true;
  if (from === "accepted") return to === "done" || to === "declined";
  return false;
}

export const isActive = (status: string) => status === "open" || status === "accepted";

/** Past needed-by and still open/accepted. */
export function isOverdue(r: { status: string; neededBy: Date | string | null }, now: Date): boolean {
  if (!r.neededBy || !isActive(r.status)) return false;
  return new Date(r.neededBy).getTime() < now.getTime();
}

/** Context auto-attached to an ask: deal snapshot + next meeting. Plain text, stored with the request. */
export function buildHelpContext(src: {
  dealName: string | null;
  stageName?: string | null;
  valueLabel?: string | null;
  summary?: string | null;
  nextStep?: string | null;
  nextStepDueAt?: string | null;
  meeting?: { title: string | null; startsAt: string | null } | null;
}): string {
  const lines: string[] = [];
  if (src.dealName) lines.push(`Deal: ${src.dealName}${src.stageName ? ` — ${src.stageName}` : ""}${src.valueLabel ? `, ${src.valueLabel}` : ""}`);
  if (src.summary) lines.push(`Where it stands: ${src.summary.trim()}`);
  if (src.nextStep) lines.push(`Next step: ${src.nextStep}${src.nextStepDueAt ? ` (due ${src.nextStepDueAt})` : ""}`);
  if (src.meeting) lines.push(`Next meeting: ${src.meeting.title ?? "Meeting"}${src.meeting.startsAt ? ` on ${src.meeting.startsAt.slice(0, 16).replace("T", " ")} UTC` : ""}`);
  return lines.join("\n").slice(0, 2000);
}

/**
 * Where a help request is answered (QA MAJ-08): on its deal when it has one, else on its own page (/help/<id>) — never
 * /home, where a meeting-only ask couldn't be declined or answered.
 */
export function helpHref(r: { id: string; dealId: string | null }): string {
  return r.dealId ? `/deals/${r.dealId}?help=${r.id}` : `/help/${r.id}`;
}
