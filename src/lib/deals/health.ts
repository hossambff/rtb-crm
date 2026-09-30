/**
 * Deal health score (PRD DEAL-8) — pure, deterministic, unit-tested.
 * Starts at 100 and deducts for: stale activity vs stage SLA, missing/overdue next step, weak stakeholder coverage,
 * stage age vs SLA and overdue open tasks. Returns a 0..100 score plus a human explanation (top factors first).
 * Email sentiment / call signals can be layered in later via `extraPenalties` (e.g. from the email module).
 */
export type HealthInput = {
  now: Date;
  category: "open" | "won" | "lost" | "hold";
  createdAt: Date;
  stageEnteredAt: Date;
  slaDays: number | null;
  lastActivityAt: Date | null;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  nextStepWaitingReason?: string | null;
  stakeholderRoles: (string | null)[];
  overdueTaskCount: number;
  /** Deal came from the spreadsheet migration (tag "imported"). With no logged activity it needs review (QA-17). */
  imported?: boolean;
  extraPenalties?: { points: number; reason: string }[];
};

/** Imported deals nobody has touched since the migration are capped here ("needs review"). */
export const IMPORTED_REVIEW_CAP = 60;

export type HealthFactor = { key: string; points: number; reason: string };
export type HealthResult = { score: number | null; explanation: string; factors: HealthFactor[] };

const DAY = 86_400_000;
const DEFAULT_SLA = 14;

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY);
}

export function computeHealth(input: HealthInput): HealthResult {
  if (input.category === "won" || input.category === "lost") {
    return { score: null, explanation: `Closed ${input.category} — health is not tracked.`, factors: [] };
  }
  const sla = input.slaDays && input.slaDays > 0 ? input.slaDays : DEFAULT_SLA;
  const factors: HealthFactor[] = [];
  const add = (key: string, points: number, reason: string) => {
    if (points > 0) factors.push({ key, points, reason });
  };

  // 1. Recency of last activity vs stage SLA. With no activity at all, the deal's age is the idle time (QA-17):
  // a never-touched deal is never "on track".
  if (input.lastActivityAt) {
    const idle = daysBetween(input.lastActivityAt, input.now);
    if (idle > 2 * sla) add("recency", 30, `No activity for ${idle} days (SLA ${sla})`);
    else if (idle > sla) add("recency", 20, `No activity for ${idle} days (SLA ${sla})`);
    else if (idle > sla / 2) add("recency", 10, `Last activity ${idle} days ago`);
  } else {
    const since = input.createdAt.getTime() < input.stageEnteredAt.getTime() ? input.createdAt : input.stageEnteredAt;
    const age = Math.max(0, daysBetween(since, input.now));
    if (age > 2 * sla) add("recency", 30, `No activity logged in ${age} days (SLA ${sla})`);
    else if (age > sla) add("recency", 20, `No activity logged in ${age} days (SLA ${sla})`);
    else add("recency", 10, "No activity logged yet");
  }

  // 2. Next step present / overdue (DEAL-3)
  if (!input.nextStep?.trim() || !input.nextStepDueAt) {
    if (input.nextStepWaitingReason?.trim()) add("next_step", 5, `Waiting: ${input.nextStepWaitingReason.trim()}`);
    else add("next_step", 20, "No next step with a due date");
  } else {
    const overdue = daysBetween(input.nextStepDueAt, input.now);
    if (overdue > 3) add("next_step", 20, `Next step overdue by ${overdue} days`);
    else if (overdue >= 1) add("next_step", 10, `Next step overdue by ${overdue} day${overdue === 1 ? "" : "s"}`);
  }

  // 3. Stakeholder coverage
  const roles = input.stakeholderRoles.map((r) => (r ?? "").toLowerCase());
  if (roles.length === 0) add("stakeholders", 15, "No stakeholders linked");
  else if (!roles.includes("decision_maker")) add("stakeholders", 8, "No decision maker engaged");

  // 4. Stage age vs SLA
  const inStage = daysBetween(input.stageEnteredAt, input.now);
  if (inStage > 2 * sla) add("stage_age", 20, `${inStage} days in stage (SLA ${sla})`);
  else if (inStage > sla) add("stage_age", 10, `${inStage} days in stage (SLA ${sla})`);

  // 5. Overdue open tasks
  if (input.overdueTaskCount > 0) {
    add("tasks", Math.min(15, input.overdueTaskCount * 5), `${input.overdueTaskCount} overdue task${input.overdueTaskCount === 1 ? "" : "s"}`);
  }

  for (const p of input.extraPenalties ?? []) add("signal", Math.max(0, p.points), p.reason);

  // 6. Imported and never worked since the migration → needs review (score ≤ 60).
  if (input.imported && !input.lastActivityAt) {
    const before = 100 - factors.reduce((a, f) => a + f.points, 0);
    if (before > IMPORTED_REVIEW_CAP) add("imported_review", before - IMPORTED_REVIEW_CAP, "Imported with no activity logged since — needs review");
  }

  const total = factors.reduce((a, f) => a + f.points, 0);
  const score = Math.max(0, Math.min(100, 100 - total));
  factors.sort((a, b) => b.points - a.points);
  const explanation = factors.length ? factors.map((f) => f.reason).join("; ") + "." : "On track: recent activity, next step scheduled, stakeholders covered.";
  return { score, explanation, factors };
}
