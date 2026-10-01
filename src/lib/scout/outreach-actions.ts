"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { checkClaims } from "@/lib/claims";
import { assertCan, ForbiddenError } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { scopeFor } from "@/lib/rbac/server";
import { gmailStatus, GMAIL_REQUIRED_MESSAGE } from "@/lib/sequences/access";
import { enrollContacts, loadEnrollableSequence, type EnrollSkip } from "@/lib/sequences/enroll";
import { suppressedEmails } from "./crm-match";
import { promoteOne } from "./enrichment";
import { generateOpeners, loadOutreachRows, saveOpenerBrief, storedOpeners } from "./outreach";
import { MAX_BATCH, sanitizeOpener } from "./outreach-core";

const ids = z.array(z.uuid()).min(1).max(MAX_BATCH);

export const generateOpenersAction = action(z.object({ ids, force: z.boolean().default(false) }), async (input, user) => {
  await assertCan(user, "email", "view");
  const r = await generateOpeners(user, input.ids, { force: input.force });
  revalidatePath("/scout");
  return r;
});

export const dismissOutreach = action(z.object({ ids }), async (input, user) => {
  const rows = await loadOutreachRows(user, input.ids);
  for (const r of rows) await saveOpenerBrief(user.id, r.ec.id, { dismissed: true });
  await audit({ actorId: user.id, action: "scout.outreach_dismiss", entity: "enriched_contact", after: { ids: rows.map((r) => r.ec.id) } });
  revalidatePath("/scout");
  return { dismissed: rows.length };
});

/**
 * SCOUT-25: the rep's explicit batch approval. For each approved person: promote the staged executive to a Contact
 * (existing promote flow), then enroll into the chosen sequence with `variables.opener`. Sending still happens through
 * the sequence runner (working hours, caps, exit rules). Nothing is sent from here.
 */
export const approveOutreachBatch = action(
  z.object({
    sequenceId: z.uuid(),
    items: z.array(z.object({ id: z.uuid(), opener: z.string().max(1000) })).min(1).max(MAX_BATCH),
  }),
  async (input, user) => {
    await assertCan(user, "email", "view");
    if (SCOPE_RANK[await scopeFor(user, "contacts", "create")] === 0) throw new ForbiddenError("Your role can't add contacts.");
    // fail fast before promoting anything: the sequence must be usable and the rep's Gmail connected
    const seq = await loadEnrollableSequence(user, input.sequenceId);
    const gm = await gmailStatus(user.id);
    if (!(gm.canSend && gm.canRead)) throw new UserError(GMAIL_REQUIRED_MESSAGE);

    const rows = await loadOutreachRows(user, input.items.map((i) => i.id));
    if (rows.length !== new Set(input.items.map((i) => i.id)).size) throw new ForbiddenError("Some of these people aren't in your outreach batch.");
    const [supp, drafts] = await Promise.all([suppressedEmails(rows.map((r) => r.ec.email ?? "").filter(Boolean)), storedOpeners(user.id, rows.map((r) => r.ec.id))]);
    const skipped: EnrollSkip[] = [];
    const perContact: Record<string, Record<string, string>> = {};
    const contactIds: string[] = [];
    let promoted = 0;
    for (const item of input.items) {
      const r = rows.find((x) => x.ec.id === item.id)!;
      const ec = r.ec;
      const opener = sanitizeOpener(item.opener);
      if (!ec.email || ec.state === "discarded") {
        skipped.push({ id: ec.id, name: ec.fullName, reason: "No longer available." });
        continue;
      }
      if (supp.has(ec.email.toLowerCase()) || r.account.doNotContact) {
        skipped.push({ id: ec.id, name: ec.fullName, reason: "Do not contact / suppressed." });
        continue;
      }
      if (!opener) {
        skipped.push({ id: ec.id, name: ec.fullName, reason: "Write an opener first." });
        continue;
      }
      const claims = await checkClaims(opener);
      if (claims.blocked) {
        skipped.push({ id: ec.id, name: ec.fullName, reason: `Opener blocked by the claims policy (${claims.hits.map((h) => h.match).join(", ")}).` });
        continue;
      }
      const wasPromoted = Boolean(ec.promotedContactId);
      const contactId = await promoteOne(ec, user.id);
      if (!wasPromoted) promoted++;
      perContact[contactId] = { opener };
      contactIds.push(contactId);
      // QA MIN-27: "edited" only when the rep actually changed the drafted opener
      await saveOpenerBrief(user.id, ec.id, { opener, edited: opener !== sanitizeOpener(drafts.get(ec.id) ?? ""), approvedAt: new Date().toISOString() });
    }
    const result = contactIds.length
      ? await enrollContacts(user, { contactIds }, { sequenceId: seq.id, perContact, source: "scout" })
      : { enrolled: 0, enrollmentIds: [], skipped: [], sequenceName: seq.name };
    await audit({
      actorId: user.id,
      action: "scout.outreach_approve",
      entity: "sequence",
      entityId: seq.id,
      after: { approved: input.items.length, promoted, enrolled: result.enrolled, skipped: skipped.length + result.skipped.length, enrollmentIds: result.enrollmentIds },
    });
    revalidatePath("/scout");
    revalidatePath("/contacts", "layout");
    revalidatePath(`/sequences/${seq.id}`);
    return { promoted, enrolled: result.enrolled, skipped: [...skipped, ...result.skipped], sequenceName: seq.name, sequenceId: seq.id };
  },
);
