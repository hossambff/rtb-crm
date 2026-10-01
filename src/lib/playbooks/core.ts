/**
 * Stage playbooks (V2 §A7) — pure, client-safe, unit tested.
 * A playbook belongs to one stage: guidance shown on the deal, a task template list created when a deal ENTERS the
 * stage (idempotent per deal × stage × task title), and email templates for the rep.
 */
import { z } from "zod";
import { addBusinessDays, dateOnlyToInstant, localDateKey, safeTz } from "@/lib/time";

export const ASSIGN_TO = ["owner", "manager", "onboarding"] as const;
export type AssignTo = (typeof ASSIGN_TO)[number];
export const TASK_PRIORITIES = ["high", "medium", "low"] as const;

export const playbookTaskSchema = z.object({
  title: z.string().trim().min(2, "Task title is too short").max(200),
  description: z.string().trim().max(1000).optional(),
  dueInDays: z.coerce.number().int().min(0).max(90),
  assignTo: z.enum(ASSIGN_TO),
  priority: z.enum(TASK_PRIORITIES).optional(),
});
export const playbookEmailSchema = z.object({
  name: z.string().trim().min(2).max(80),
  subject: z.string().trim().min(2).max(200),
  body: z.string().trim().min(2).max(5000),
});
export const playbookInputSchema = z.object({
  stageId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  guidance: z.string().trim().max(2000).optional().or(z.literal("")),
  tasks: z.array(playbookTaskSchema).max(12, "Keep a playbook to 12 tasks or fewer"),
  emailTemplates: z.array(playbookEmailSchema).max(6, "Keep a playbook to 6 email templates or fewer"),
  active: z.boolean(),
});
export type PlaybookTask = z.infer<typeof playbookTaskSchema>;
export type PlaybookEmail = z.infer<typeof playbookEmailSchema>;
export type PlaybookInput = z.infer<typeof playbookInputSchema>;

/** tasks.evidence_source marker: one per stage; re-entering the stage never duplicates a task. */
export const playbookSource = (stageId: string) => `playbook:${stageId}`;

const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/** Template tasks that don't exist yet on the deal for this stage (by normalized title, any status). */
export function tasksToCreate(templates: PlaybookTask[], existingTitles: string[]): PlaybookTask[] {
  const have = new Set(existingTitles.map(norm));
  const out: PlaybookTask[] = [];
  for (const t of templates) {
    const k = norm(t.title);
    if (!k || have.has(k)) continue;
    have.add(k);
    out.push(t);
  }
  return out;
}

/** Who gets a playbook task. Falls back to the deal owner, then the actor. */
export function resolveAssignee(assignTo: AssignTo, ctx: { ownerId: string | null; managerId: string | null; onboardingId: string | null; actorId: string }): string {
  const owner = ctx.ownerId ?? ctx.actorId;
  if (assignTo === "manager") return ctx.managerId ?? owner;
  if (assignTo === "onboarding") return ctx.onboardingId ?? owner;
  return owner;
}

/** Due instant for "due in N business days": that local date at 17:00 in `tz` (same convention as date inputs). */
export function playbookDueAt(now: Date, dueInDays: number, tz: string): Date {
  const zone = safeTz(tz);
  const day = dueInDays > 0 ? addBusinessDays(now, dueInDays, zone) : now;
  return dateOnlyToInstant(localDateKey(day, zone), zone);
}

/** The next-step suggestion for entering a stage: the playbook's first owner task (or first task). */
export function firstStep(tasks: PlaybookTask[] | null | undefined): { title: string; dueInDays: number } | null {
  if (!tasks?.length) return null;
  const t = tasks.find((x) => x.assignTo === "owner") ?? tasks[0]!;
  return { title: t.title, dueInDays: t.dueInDays };
}

/** `YYYY-MM-DD` that is `n` business days after `now` in `tz` (default value for date inputs). */
export function businessDateInput(now: Date, n: number, tz: string): string {
  const zone = safeTz(tz);
  return localDateKey(n > 0 ? addBusinessDays(now, n, zone) : now, zone);
}

/** Substitute {{first_name}} {{company}} {{sender_first_name}} {{deal}} in a template; unknown tokens are left visible. */
export function fillTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k: string) => {
    const v = vars[k.toLowerCase()];
    return v ? v : m;
  });
}
