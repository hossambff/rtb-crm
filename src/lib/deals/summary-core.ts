/**
 * Deal AI summary (PRD CARD-2): output schema + deterministic heuristic fallback. Pure (no server deps) so it is unit
 * tested and the client can parse the stored JSON.
 */
import { z } from "zod";

export const dealSummarySchema = z.object({
  summary: z.string().describe("2-4 sentences: where the deal stands right now"),
  lastTouch: z.string().describe("Most recent meaningful touch, with date and channel"),
  ourCommitments: z.array(z.string()).describe("Open promises RTB made to the prospect"),
  theirCommitments: z.array(z.string()).describe("Open promises the prospect made to RTB"),
  risks: z.array(z.string()).describe("Concrete risks to closing"),
  nextAction: z.string().describe("Single recommended next action"),
  citations: z
    .array(z.object({ ref: z.string().describe("activity:<id> | task:<id> | field:<name>"), quote: z.string() }))
    .describe("Sources for the claims above"),
});
export type DealSummary = z.infer<typeof dealSummarySchema>;
export type StoredDealSummary = DealSummary & { engine: string; generatedAt: string };

export type SummaryContext = {
  now: Date;
  deal: {
    name: string;
    stageName: string;
    category: string;
    daysInStage: number;
    nextStep: string | null;
    nextStepDueAt: Date | null;
    valueLabel: string;
    ownerName: string | null;
  };
  activities: { id: string; type: string; subject: string | null; body: string | null; occurredAt: Date; actorName: string | null }[];
  openTasks: { id: string; title: string; dueAt: Date | null; owedBy: string | null; evidence: string | null }[];
  stakeholders: { name: string; role: string | null; title: string | null }[];
  healthExplanation: string | null;
};

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function heuristicSummary(ctx: SummaryContext): DealSummary {
  const { deal } = ctx;
  const touches = ctx.activities.filter((a) => !["system", "field_change"].includes(a.type));
  const last = touches[0];
  const summary = [
    `${deal.name} is in ${deal.stageName} (${deal.daysInStage} day${deal.daysInStage === 1 ? "" : "s"} in stage), valued at ${deal.valueLabel}.`,
    deal.ownerName ? `Owned by ${deal.ownerName}.` : "No owner assigned.",
    `${touches.length} logged touch${touches.length === 1 ? "" : "es"} in the recent timeline; ${ctx.stakeholders.length} stakeholder${ctx.stakeholders.length === 1 ? "" : "s"} linked.`,
  ].join(" ");
  const lastTouch = last
    ? `${last.type.replace("_", " ")} on ${fmt(last.occurredAt)}${last.subject ? `: ${last.subject}` : ""}${last.actorName ? ` (${last.actorName})` : ""}`
    : "No touches logged yet.";
  const commitment = (t: SummaryContext["openTasks"][number]) => `${t.title}${t.dueAt ? ` (due ${fmt(t.dueAt)})` : ""}`;
  const ourCommitments = ctx.openTasks.filter((t) => t.owedBy !== "them").map(commitment);
  const theirCommitments = ctx.openTasks.filter((t) => t.owedBy === "them").map(commitment);

  const risks: string[] = [];
  if (ctx.healthExplanation && !ctx.healthExplanation.startsWith("On track")) {
    risks.push(...ctx.healthExplanation.replace(/\.$/, "").split("; "));
  }
  const overdueOurs = ctx.openTasks.filter((t) => t.owedBy !== "them" && t.dueAt && t.dueAt < ctx.now);
  if (overdueOurs.length) risks.push(`${overdueOurs.length} of our commitments are overdue`);
  if (!ctx.stakeholders.some((s) => s.role === "decision_maker")) risks.push("Decision maker not identified");

  let nextAction: string;
  if (deal.category !== "open") nextAction = deal.category === "hold" ? "Agree a re-engagement date with the prospect." : "No action — deal is closed.";
  else if (overdueOurs[0]) nextAction = `Deliver overdue commitment: ${overdueOurs[0].title}`;
  else if (deal.nextStep) nextAction = `${deal.nextStep}${deal.nextStepDueAt ? ` by ${fmt(deal.nextStepDueAt)}` : ""}`;
  else nextAction = "Set a next step with a due date.";

  const citations = [
    ...(last ? [{ ref: `activity:${last.id}`, quote: (last.subject ?? last.body ?? last.type).slice(0, 140) }] : []),
    ...ctx.openTasks.slice(0, 3).map((t) => ({ ref: `task:${t.id}`, quote: (t.evidence ?? t.title).slice(0, 140) })),
  ];
  return { summary, lastTouch, ourCommitments, theirCommitments, risks: Array.from(new Set(risks)).slice(0, 6), nextAction, citations };
}

/** Parse deals.aiSummary (JSON written by this module, or legacy markdown/plain text from elsewhere). */
export function parseStoredSummary(raw: string | null | undefined): StoredDealSummary | { text: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    const parsed = dealSummarySchema.safeParse(obj);
    if (parsed.success) {
      const o = obj as { engine?: unknown; generatedAt?: unknown };
      return { ...parsed.data, engine: typeof o.engine === "string" ? o.engine : "unknown", generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : "" };
    }
  } catch {
    /* not JSON */
  }
  return { text: raw };
}
