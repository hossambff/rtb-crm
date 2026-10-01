"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { ForbiddenError, assertCan, type AppUser } from "@/lib/rbac/server";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { getTranscriptForUser } from "./queries";
import { analyzeTranscript } from "./analyze";
import { applyTranscriptReview } from "./apply";
import { setTranscriptDeal } from "./ingest";
import { detectTranscriptSignals, expireSignalsForSources } from "@/lib/signals/service";
import { runPostCallAutopilot, undoPostCallAutopilot } from "./autopilot";
import { followUpRecipients, saveFollowUpDraft } from "./drafts";

async function editable(user: AppUser, id: string) {
  await assertCan(user, "calls", "view");
  const t = await getTranscriptForUser(user, id);
  if (!t) throw new UserError("Transcript not found.");
  if (!t.canEdit) throw new ForbiddenError("Only the call owner (or their manager) can change this transcript.");
  return t;
}

export const reanalyzeTranscript = action(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await editable(user, id);
  const a = await analyzeTranscript(id);
  await audit({ actorId: user.id, action: "transcript.reanalyze", entity: "transcript", entityId: id, after: { engine: a?.engine ?? null } });
  revalidatePath(`/calls/${id}`);
  revalidatePath("/calls");
  if (!a) throw new UserError("Analysis failed. Check the transcript text and try again.");
  return { engine: a.engine };
});

export const attachTranscriptDeal = action(z.object({ id: z.uuid(), dealId: z.uuid().nullable() }), async ({ id, dealId }, user) => {
  const t = await editable(user, id);
  if (dealId && !(await getAccessibleDeal(user, dealId, "view"))) throw new ForbiddenError("You can't attach transcripts to that deal.");
  await setTranscriptDeal(id, dealId);
  await audit({ actorId: user.id, action: dealId ? "transcript.attach_deal" : "transcript.detach_deal", entity: "transcript", entityId: id, before: { dealId: t.transcript.dealId }, after: { dealId } });
  // Signals belong to the deal they were detected for; a newly attached deal gets its own (and the autopilot, if on).
  await expireSignalsForSources("transcript", [id], { dealId });
  if (dealId && t.transcript.status === "ready" && t.analysis) {
    await detectTranscriptSignals(id, t.analysis);
    await runPostCallAutopilot(id);
  }
  revalidatePath(`/calls/${id}`);
  revalidatePath("/calls");
  return true;
});

export const applyCallReview = action(
  z.object({
    id: z.uuid(),
    actionItems: z
      .array(
        z.object({
          task: z.string().trim().min(1, "Task text is required").max(300),
          owner: z.string().trim().max(80).default("us"),
          due: z.string().nullable().default(null),
          evidence: z.string().max(1000).default(""),
          timestamp: z.string().max(12).nullable().default(null),
          itemId: z.string().max(80).optional(),
        }),
      )
      .max(30),
    fieldUpdates: z.array(z.object({ field: z.enum(["muu", "next_step", "expected_close_date"]), value: z.string().trim().min(1).max(500) })).max(5),
    stageId: z.uuid().nullable().default(null),
  }),
  async (input, user) => {
    await editable(user, input.id);
    if (input.actionItems.length) await assertCan(user, "tasks", "create");
    for (const a of input.actionItems) {
      if (a.due && Number.isNaN(new Date(a.due).getTime())) throw new UserError(`Invalid due date for “${a.task.slice(0, 40)}”.`);
    }
    const r = await applyTranscriptReview(user, input.id, { actionItems: input.actionItems, fieldUpdates: input.fieldUpdates, stageId: input.stageId });
    revalidatePath(`/calls/${input.id}`);
    revalidatePath("/calls");
    return r;
  },
);

/** V2 A1: undo the post-call autopilot (24 h window; owner only). */
export const undoCallAutopilot = action(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await editable(user, id);
  const r = await undoPostCallAutopilot(user, id);
  revalidatePath(`/calls/${id}`);
  revalidatePath("/calls");
  return r;
});

/**
 * V2 A1 "Apply all + draft" / "Save draft": write the follow-up as a Gmail draft (or keep it in-app when Gmail compose
 * isn't granted or the claims/MNPI guardrail flagged it). Never sends.
 */
export const saveCallDraft = action(
  z.object({
    id: z.uuid(),
    to: z.array(z.email("Invalid email address").max(254)).max(10).default([]),
    subject: z.string().trim().max(300).default(""),
    body: z.string().trim().min(1, "The draft is empty").max(50_000),
  }),
  async (input, user) => {
    await assertCan(user, "email", "view");
    const t = await editable(user, input.id);
    if (t.transcript.uploadedBy !== user.id) throw new ForbiddenError("Drafts go to the call owner's mailbox — only they can save one.");
    const auto = input.to.length ? null : await followUpRecipients(t.transcript, user);
    const to = input.to.length ? input.to : auto!.to;
    const d = await saveFollowUpDraft(user, input.id, { to, subject: input.subject, body: input.body, unverified: auto?.unverified }, { auto: false });
    revalidatePath(`/calls/${input.id}`);
    return { location: d.location, status: d.status, needsReconnect: d.needsReconnect, warnings: d.warnings };
  },
);
