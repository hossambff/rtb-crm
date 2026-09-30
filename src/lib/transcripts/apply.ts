import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { isFieldHidden } from "@/lib/rbac/model";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { parseAudience } from "@/lib/domain";
import type { TranscriptAnalysis } from "./analysis-core";

/**
 * ⚠️ CONSOLIDATE LATER: the deals module owns stage changes (gates, required fields, approvals, alerts).
 * This is a minimal, permission-checked stand-in used by the post-call Apply screen until that module is merged —
 * replace the body with a call to the deals module's stage-change service.
 */
export async function applyStageChange(user: AppUser, dealId: string, toStageId: string, reason: string) {
  const deal = await getAccessibleDeal(user, dealId, "edit");
  if (!deal) throw new ForbiddenError("You can't edit this deal.");
  const [stage] = await db
    .select()
    .from(s.stages)
    .where(and(eq(s.stages.id, toStageId), eq(s.stages.pipelineId, deal.pipelineId)));
  if (!stage) throw new UserError("That stage doesn't belong to this deal's pipeline.");
  if (stage.id === deal.stageId) return { changed: false };
  if (stage.requiresApproval) throw new UserError(`Moving to “${stage.name}” requires approval — change it from the deal page.`);
  if (stage.category === "won" || stage.category === "lost") {
    throw new UserError("Mark deals Won/Lost from the deal page (it asks for the required close details).");
  }
  const now = new Date();
  await db
    .update(s.deals)
    .set({ stageId: stage.id, stageEnteredAt: now, status: stage.category, lastActivityAt: now })
    .where(eq(s.deals.id, dealId));
  await db.insert(s.dealStageHistory).values({ dealId, fromStageId: deal.stageId, toStageId: stage.id, changedBy: user.id, reason });
  await db.insert(s.activities).values({
    type: "stage_change",
    source: "manual",
    subject: `Stage → ${stage.name}`,
    body: reason,
    actorId: user.id,
    dealId,
    accountId: deal.accountId,
    metadata: { fromStageId: deal.stageId, toStageId: stage.id },
  });
  await audit({ actorId: user.id, action: "deal.stage_change", entity: "deal", entityId: dealId, before: { stageId: deal.stageId }, after: { stageId: stage.id, reason } });
  return { changed: true };
}

export type ApplyInput = {
  actionItems: { task: string; owner: string; due: string | null; evidence: string; timestamp: string | null }[];
  fieldUpdates: { field: "muu" | "next_step" | "expected_close_date"; value: string }[];
  stageId: string | null;
};

const FIELD_COLUMN = { muu: "muu", next_step: "nextStep", expected_close_date: "expectedCloseDate" } as const;

/** CALL-7: apply the reviewed subset. Tasks get origin call_ai + evidence/timestamp; field/stage updates are RBAC-checked. */
export async function applyTranscriptReview(user: AppUser, transcriptId: string, input: ApplyInput) {
  const [t] = await db.select().from(s.transcripts).where(eq(s.transcripts.id, transcriptId));
  if (!t) throw new UserError("Transcript not found.");
  const ourName = user.name.toLowerCase().split(/\s+/)[0] ?? "";

  const taskIds: string[] = [];
  for (const a of input.actionItems) {
    const owner = a.owner.trim().toLowerCase();
    const theirs = owner === "them" || (owner !== "us" && owner !== "" && !owner.includes(ourName) && owner !== user.name.toLowerCase());
    const [row] = await db
      .insert(s.tasks)
      .values({
        title: (theirs ? `Waiting on ${a.owner === "them" ? "them" : a.owner}: ${a.task}` : a.task).slice(0, 240),
        dueAt: a.due ? new Date(a.due) : null,
        assigneeId: user.id,
        createdBy: user.id,
        dealId: t.dealId,
        accountId: t.accountId,
        origin: "call_ai",
        owedBy: theirs ? "them" : "us",
        evidence: a.evidence.slice(0, 1000) || null,
        evidenceSource: `transcript:${t.id}${a.timestamp ? `@${a.timestamp}` : ""}`,
      })
      .returning({ id: s.tasks.id });
    taskIds.push(row!.id);
  }

  const applied: Record<string, unknown> = {};
  if ((input.fieldUpdates.length || input.stageId) && !t.dealId) throw new UserError("Attach a deal before applying field or stage updates.");
  if (t.dealId && input.fieldUpdates.length) {
    const deal = await getAccessibleDeal(user, t.dealId, "edit");
    if (!deal) throw new ForbiddenError("You can't edit this deal.");
    const set: Partial<typeof s.deals.$inferInsert> = {};
    for (const f of input.fieldUpdates) {
      const col = FIELD_COLUMN[f.field];
      if (!col || isFieldHidden(user.role, "deal", col)) throw new ForbiddenError(`You can't edit ${f.field.replace(/_/g, " ")}.`);
      if (f.field === "muu") {
        const n = parseAudience(f.value);
        if (!n) throw new UserError("MUU must be a number (e.g. 2500000 or 2.5M).");
        set.muu = n;
      } else if (f.field === "next_step") {
        set.nextStep = f.value.slice(0, 500);
      } else {
        const d = new Date(f.value);
        if (Number.isNaN(d.getTime())) throw new UserError("Expected close date is not a valid date.");
        set.expectedCloseDate = d;
      }
    }
    if (Object.keys(set).length) {
      await db.update(s.deals).set(set).where(eq(s.deals.id, t.dealId));
      await audit({
        actorId: user.id,
        action: "deal.update_from_call",
        entity: "deal",
        entityId: t.dealId,
        before: { muu: deal.muu, nextStep: deal.nextStep, expectedCloseDate: deal.expectedCloseDate },
        after: { ...set, source: `transcript:${t.id}` },
      });
      await db.insert(s.activities).values({
        type: "field_change",
        source: "manual",
        subject: "Deal updated from call",
        body: input.fieldUpdates.map((f) => `${f.field.replace(/_/g, " ")}: ${f.value}`).join("\n"),
        actorId: user.id,
        dealId: t.dealId,
        accountId: t.accountId,
        transcriptId: t.id,
      });
      applied.fields = set;
    }
  }
  if (t.dealId && input.stageId) {
    const r = await applyStageChange(user, t.dealId, input.stageId, `Applied from call review (transcript ${t.title ?? t.id})`);
    applied.stageChanged = r.changed;
  }

  const analysis = (t.analysis ?? {}) as Partial<TranscriptAnalysis> & { applied?: unknown[] };
  const history = Array.isArray(analysis.applied) ? analysis.applied : [];
  await db
    .update(s.transcripts)
    .set({
      appliedAt: new Date(),
      analysis: { ...analysis, applied: [...history, { at: new Date().toISOString(), by: user.id, taskIds, ...applied }] } as Record<string, unknown>,
    })
    .where(eq(s.transcripts.id, t.id));
  await audit({ actorId: user.id, action: "transcript.apply", entity: "transcript", entityId: t.id, after: { tasks: taskIds.length, ...applied } });
  return { tasks: taskIds.length, fields: input.fieldUpdates.length, stageChanged: Boolean(applied.stageChanged) };
}
