/** Onboarding / migration helpers (PRD ONB-1..3). Pure, unit tested. */

export const MIGRATION_STAGES = ["discovery", "scoping", "clone_built", "content_migrated", "qa", "launched", "live", "paused"] as const;
export type MigrationStage = (typeof MIGRATION_STAGES)[number];
export const MIGRATION_STAGE_LABELS: Record<MigrationStage, string> = {
  discovery: "Discovery",
  scoping: "Scoping",
  clone_built: "Clone built",
  content_migrated: "Content migrated",
  qa: "QA",
  launched: "Launched",
  live: "Hypercare / Live",
  paused: "Paused",
};

export const DEFAULT_CHECKLIST = [
  "Kickoff call",
  "DNS / access",
  "Content export",
  "AI clone built",
  "Archive migrated",
  "Ad stack configured",
  "QA pass",
  "Launch comms",
  "Hypercare 30d",
] as const;

export function defaultChecklist(): { item: string; done: boolean }[] {
  return DEFAULT_CHECKLIST.map((item) => ({ item, done: false }));
}

export const STALL_DAYS = 10;

export function daysInStage(stageEnteredAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - stageEnteredAt.getTime()) / 86_400_000));
}

/** Stalled = still in an active stage longer than the threshold (NS-19). Launched/live/paused don't stall. */
export function isStalled(p: { stage: string; stageEnteredAt: Date }, now: Date, days = STALL_DAYS): boolean {
  if (p.stage === "launched" || p.stage === "live" || p.stage === "paused") return false;
  return daysInStage(p.stageEnteredAt, now) > days;
}

/** Go-live slipped = target date passed without an actual go-live (NS-20). */
export function hasSlipped(p: { targetGoLive: Date | null; actualGoLive: Date | null; launched: boolean }, now: Date): boolean {
  if (!p.targetGoLive || p.launched || p.actualGoLive) return false;
  return p.targetGoLive.getTime() < now.getTime();
}

export function checklistProgress(list: { done: boolean }[]): { done: number; total: number; pct: number } {
  const done = list.filter((c) => c.done).length;
  return { done, total: list.length, pct: list.length ? done / list.length : 0 };
}

/** Side effects of moving to a stage. */
export function stageTransition(
  p: { launched: boolean; actualGoLive: Date | null },
  to: MigrationStage,
  now: Date,
): { launched: boolean; actualGoLive: Date | null } {
  if (to === "launched" || to === "live") return { launched: true, actualGoLive: p.actualGoLive ?? now };
  return { launched: p.launched, actualGoLive: p.actualGoLive };
}
