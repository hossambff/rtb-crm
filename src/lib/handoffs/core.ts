/**
 * Structured handoffs (V2 §C3) — pure, client-safe, unit tested.
 * SDR → AE, AE → Onboarding, or a plain reassign: the sender writes a brief; ownership moves only when the receiver
 * accepts. Pending handoffs escalate to the receiver's manager after 2 business days.
 */
import { z } from "zod";
import { businessDaysPassed } from "@/lib/alerts/time";

export const HANDOFF_KINDS = ["sdr_to_ae", "ae_to_onboarding", "reassign"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
export const HANDOFF_KIND_LABEL: Record<HandoffKind, string> = { sdr_to_ae: "SDR → AE", ae_to_onboarding: "AE → Onboarding", reassign: "Reassign" };

export const MIN_CONTEXT = 40;
export const ESCALATE_AFTER_BUSINESS_DAYS = 2;

export const handoffBriefSchema = z.object({
  context: z.string().trim().min(MIN_CONTEXT, `Give the receiver real context (at least ${MIN_CONTEXT} characters)`).max(4000),
  stakeholders: z.string().trim().max(2000).optional(),
  commitments: z.string().trim().max(2000).optional(),
  risks: z.string().trim().max(2000).optional(),
  nextStep: z.string().trim().max(500).optional(),
});
export type HandoffBrief = z.infer<typeof handoffBriefSchema>;

export type BriefSource = {
  dealName: string;
  stageName: string;
  daysInStage: number;
  valueLabel: string;
  accountName: string | null;
  summary: string | null; // stored AI/heuristic summary sentence(s)
  nextStep: string | null;
  nextStepDueAt: string | null; // YYYY-MM-DD
  lastTouch: string | null; // e.g. "call on 2026-09-28: pricing"
  stakeholders: { name: string; title: string | null; role: string | null; primary: boolean }[];
  openTasks: { title: string; owedBy: string | null; dueAt: string | null }[];
  healthExplanation: string | null;
  coverageGaps: string[];
};

const ROLE_WORD: Record<string, string> = {
  decision_maker: "decision maker",
  champion: "champion",
  influencer: "influencer",
  finance: "economic buyer",
  legal: "legal",
  tech: "technical",
  blocker: "blocker",
};

/** Deterministic brief from deal data (also the fallback when AI is off, restricted, or fails). */
export function heuristicBrief(src: BriefSource): HandoffBrief {
  const ctx = [
    src.summary?.trim() ||
      `${src.dealName}${src.accountName && src.accountName !== src.dealName ? ` (${src.accountName})` : ""} is in ${src.stageName} for ${src.daysInStage} day${src.daysInStage === 1 ? "" : "s"}, valued at ${src.valueLabel}.`,
    src.lastTouch ? `Last touch: ${src.lastTouch}.` : "No logged touches yet.",
  ].join(" ");
  const stakeholders = src.stakeholders.length
    ? src.stakeholders
        .slice(0, 8)
        .map((c) => `${c.name}${c.title ? `, ${c.title}` : ""}${c.role ? ` — ${ROLE_WORD[c.role] ?? c.role}` : ""}${c.primary ? " (primary)" : ""}`)
        .join("\n")
    : "No stakeholders linked yet.";
  const ours = src.openTasks.filter((t) => t.owedBy !== "them");
  const theirs = src.openTasks.filter((t) => t.owedBy === "them");
  const line = (t: BriefSource["openTasks"][number]) => `${t.title}${t.dueAt ? ` (due ${t.dueAt})` : ""}`;
  const commitments = [
    ours.length ? `We owe: ${ours.slice(0, 5).map(line).join("; ")}` : null,
    theirs.length ? `They owe: ${theirs.slice(0, 5).map(line).join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n") || "No open commitments.";
  const riskList = [
    ...(src.healthExplanation && !/^on track/i.test(src.healthExplanation) ? src.healthExplanation.replace(/\.$/, "").split("; ") : []),
    ...src.coverageGaps,
  ];
  const risks = riskList.length ? Array.from(new Set(riskList)).slice(0, 6).join("\n") : "None flagged.";
  const nextStep = src.nextStep ? `${src.nextStep}${src.nextStepDueAt ? ` (due ${src.nextStepDueAt})` : ""}` : "";
  return { context: ctx, stakeholders, commitments, risks, nextStep };
}

/** Pending for ≥ 2 business days in the receiver's zone → escalate to their manager. */
export function shouldEscalate(createdAt: Date, now: Date, tz: string): boolean {
  return businessDaysPassed(createdAt, now, ESCALATE_AFTER_BUSINESS_DAYS, tz);
}

/** app_settings key that stamps a handoff as escalated (once-only; there is no column for it). */
export const handoffEscalatedKey = (handoffId: string) => `handoff.escalated:${handoffId}`;

/**
 * The manager's notification for a handoff pending ≥ 2 business days (QA MIN-17). Restricted deals (or deals on a
 * restricted account): no deal name, no brief text, flagged sensitive so it never leaves the app.
 */
export function handoffEscalationNotice(
  h: { dealName: string; toName: string | null; fromName: string | null; createdAt: Date },
  restricted: boolean,
): { title: string; body: string | null; sensitive: boolean } {
  const to = h.toName ?? "Your report";
  if (restricted) return { title: `${to} hasn't picked up a handoff on a restricted deal`, body: null, sensitive: true };
  return {
    title: `${to} hasn't picked up ${h.dealName}`,
    body: `Handoff from ${h.fromName ?? "a teammate"} waiting since ${h.createdAt.toISOString().slice(0, 10)} — nudge or reassign.`,
    sensitive: false,
  };
}

/** Roles that can take an SDR's qualified deal (QA MAJ-09): never another SDR, an intern or a commission rep. */
export const SDR_TO_AE_ROLES = ["ae", "sales_leader", "executive", "super_admin"] as const;
/** Roles that run onboarding (AE → Onboarding receivers). */
export const ONBOARDING_ROLES = ["onboarding", "admin", "super_admin"] as const;

/** Who can be a receiver for a kind, given their role (the permission audience is checked separately). */
export function roleFitsKind(kind: HandoffKind, role: string): boolean {
  if (kind === "ae_to_onboarding") return (ONBOARDING_ROLES as readonly string[]).includes(role);
  if (kind === "sdr_to_ae") return (SDR_TO_AE_ROLES as readonly string[]).includes(role);
  return !["viewer", "finance", "onboarding", "pending"].includes(role);
}

/**
 * CR M1: accepting a handoff must not undo an ownership change made after it was sent. `expectedOwnerId` is the owner
 * recorded when the handoff was created (legacy rows: the sender). Onboarding handoffs don't move ownership → no check.
 */
export function ownerChangedSince(kind: HandoffKind, expectedOwnerId: string | null | undefined, currentOwnerId: string | null): boolean {
  if (kind === "ae_to_onboarding") return false;
  if (expectedOwnerId === undefined) return false;
  return (expectedOwnerId ?? null) !== (currentOwnerId ?? null);
}

/** Postgres unique violation on the one-pending-handoff-per-deal index (CR L6 / QA MIN-14). */
export function isPendingHandoffConflict(e: unknown): boolean {
  const pick = (x: unknown) => (x && typeof x === "object" ? (x as { code?: string; constraint_name?: string; constraint?: string }) : null);
  for (const c of [pick(e), pick((e as { cause?: unknown } | null)?.cause)]) {
    if (c?.code === "23505" && (c.constraint_name ?? c.constraint ?? "handoffs_one_pending_uq") === "handoffs_one_pending_uq") return true;
  }
  return false;
}
