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
