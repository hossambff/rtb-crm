/**
 * Zero-touch post-call (V2 A1) — pure planning logic, unit-tested.
 * Decides which items of a transcript analysis are confident enough to apply without a review, and phrases the
 * notification. Stage changes are never planned here: they become deal signals (src/lib/signals).
 */
import type { TranscriptAnalysis } from "./analysis-core";

export const AUTOPILOT_UNDO_MS = 24 * 60 * 60 * 1000;
export const MAX_AUTO_TASKS = 6;

export type PlannedTask = { itemId: string; task: string; owner: string; due: string | null; evidence: string; timestamp: string | null };
export type AutoPlan = { tasks: PlannedTask[]; nextStep: { text: string; due: string; evidence: string } | null };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * High-confidence subset:
 * - action items must carry a verbatim evidence quote (normalizeAiTranscriptAnalysis drops ungrounded ones) and a real task;
 * - heuristic (rules) analyses are noisier, so they additionally need a due date or to be owed by us;
 * - the next step comes from a grounded next_step field update, else our first dated (then any) commitment.
 */
export function planAutoApply(a: Pick<TranscriptAnalysis, "action_items" | "field_updates" | "engine">, opts: { defaultDue: Date; alreadyAppliedItemIds?: Set<string> }): AutoPlan {
  const heuristic = a.engine === "heuristic";
  const seen = new Set<string>();
  const tasks: PlannedTask[] = [];
  for (const it of a.action_items) {
    if (tasks.length >= MAX_AUTO_TASKS) break;
    const task = it.task.trim();
    if (task.length < 8 || !it.evidence.trim()) continue;
    if (opts.alreadyAppliedItemIds?.has(it.id)) continue;
    if (heuristic && !it.due && it.owner !== "us") continue;
    const key = norm(task).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ itemId: it.id, task: task.slice(0, 300), owner: it.owner || "us", due: it.due, evidence: it.evidence.slice(0, 1000), timestamp: it.timestamp });
  }

  let nextStep: AutoPlan["nextStep"] = null;
  const field = a.field_updates.find((f) => f.field === "next_step" && f.value.trim() && f.evidence.trim());
  const ours = tasks.filter((t) => t.owner === "us");
  const source = ours.find((t) => t.due) ?? ours[0] ?? null;
  if (field) {
    const match = tasks.find((t) => norm(t.task) === norm(field.value)) ?? source;
    nextStep = { text: field.value.trim().slice(0, 240), due: match?.due ?? opts.defaultDue.toISOString(), evidence: field.evidence.slice(0, 500) };
  } else if (source) {
    nextStep = { text: source.task.slice(0, 240), due: source.due ?? opts.defaultDue.toISOString(), evidence: source.evidence.slice(0, 500) };
  }
  return { tasks, nextStep };
}

/** "Call with Reach processed: 3 tasks, next step set, follow-up drafted" */
export function autopilotSummary(o: { who: string | null; tasks: number; nextStep: boolean; draft: "gmail" | "app" | "flagged" | "needs_recipients" | null }): string {
  const parts: string[] = [];
  if (o.tasks) parts.push(`${o.tasks} task${o.tasks === 1 ? "" : "s"}`);
  if (o.nextStep) parts.push("next step set");
  if (o.draft === "gmail") parts.push("follow-up drafted in Gmail");
  else if (o.draft === "app") parts.push("follow-up drafted");
  else if (o.draft === "flagged") parts.push("follow-up needs a review");
  else if (o.draft === "needs_recipients") parts.push("follow-up saved — add a recipient");
  const head = `Call${o.who ? ` with ${o.who}` : ""} processed`;
  return parts.length ? `${head}: ${parts.join(", ")}` : `${head} — nothing to apply automatically`;
}

export function undoAvailable(appliedAt: string | null | undefined, undoneAt: string | null | undefined, now: Date): boolean {
  if (!appliedAt || undoneAt) return false;
  const t = new Date(appliedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t <= AUTOPILOT_UNDO_MS;
}

export type AutopilotRecord = {
  status: "applied" | "skipped" | "undone";
  reason?: string | null;
  at: string;
  by: string;
  taskIds: string[];
  itemIds: string[];
  nextStep: { before: { text: string | null; due: string | null }; after: { text: string; due: string } } | null;
  undoneAt?: string | null;
  undoneBy?: string | null;
  /** titles as created, so undo leaves tasks the rep renamed alone (CR L4) */
  taskTitles?: Record<string, string>;
};

/**
 * Undo restores the previous next step only when the deal still shows exactly what the autopilot set — text AND due
 * date (CR L4: a rep who only moved the due date keeps that edit).
 */
export function nextStepUntouched(current: { text: string | null; due: Date | string | null }, after: { text: string; due: string }): boolean {
  if ((current.text ?? "") !== after.text) return false;
  const a = current.due ? new Date(current.due).getTime() : null;
  const b = after.due ? new Date(after.due).getTime() : null;
  return a === b;
}

/** Cancel an auto task on undo only while it is still the autopilot's: open, unassigned-away, unrenamed (CR L4). */
export function taskStillAutopilots(task: { status: string; assigneeId: string | null; title: string }, owner: string, originalTitle: string | undefined): boolean {
  if (task.status !== "open") return false;
  if (task.assigneeId !== owner) return false;
  if (originalTitle !== undefined && task.title !== originalTitle) return false;
  return true;
}
