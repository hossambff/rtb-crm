import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { BriefSource } from "@/lib/handoffs/core";
import { coverageGaps } from "./rules";
import { parseStoredSummary } from "./summary-core";
import { loadSummaryContext } from "./summary";

/**
 * Deal facts for a handoff brief / help-request context (caller has checked the user can view the deal).
 * Hidden fields stay hidden (rev share never enters the value label); private activity bodies are dropped upstream.
 */
export async function loadBriefSource(dealId: string, hidden: Set<string>): Promise<{ restricted: boolean; src: BriefSource; activities: { id: string; type: string; subject: string | null; body: string | null; occurredAt: Date }[] }> {
  const [{ restricted, summary }, [row]] = await Promise.all([
    loadSummaryContext(dealId, hidden),
    db
      .select({ aiSummary: s.deals.aiSummary, accountName: s.accounts.name, primaryContactId: s.deals.primaryContactId })
      .from(s.deals)
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(eq(s.deals.id, dealId)),
  ]);
  const stored = parseStoredSummary(row?.aiSummary);
  const summaryText = stored && "summary" in stored ? stored.summary : null;
  const touch = summary.activities.find((a) => !["system", "field_change", "stage_change"].includes(a.type));
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    restricted,
    activities: summary.activities.map((a) => ({ id: a.id, type: a.type, subject: a.subject, body: a.body, occurredAt: a.occurredAt })),
    src: {
      dealName: summary.deal.name,
      stageName: summary.deal.stageName,
      daysInStage: summary.deal.daysInStage,
      valueLabel: summary.deal.valueLabel,
      accountName: row?.accountName ?? null,
      summary: summaryText,
      nextStep: summary.deal.nextStep,
      nextStepDueAt: iso(summary.deal.nextStepDueAt),
      lastTouch: touch ? `${touch.type} on ${iso(touch.occurredAt)}${touch.subject ? `: ${touch.subject}` : ""}` : null,
      stakeholders: summary.stakeholders.map((c) => ({ name: c.name, title: c.title, role: c.role, primary: false })),
      openTasks: summary.openTasks.map((t) => ({ title: t.title, owedBy: t.owedBy, dueAt: iso(t.dueAt) })),
      healthExplanation: summary.healthExplanation,
      coverageGaps: coverageGaps(summary.stakeholders.map((c) => c.role)),
    },
  };
}
