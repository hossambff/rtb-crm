import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { can, type AppUser } from "@/lib/rbac/server";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { AUTOFILL_KEY, expectedCloseFromSla, pickPrimaryContact, readAutofill, suggestPriority, suggestSource, type Autofill, type AutofillField } from "./create-core";
import { getPicklist, getStagesByPipeline } from "./queries";
import { recomputeDealHealth } from "./service";

/**
 * Post-create enrichment (V2 §B4): fill priority, expected close, primary contact and source — only fields the rep left
 * empty — and record each in customFields.__autofill so the deal page shows an "auto" marker with an undo.
 * Heuristic first (synchronous, a few indexed queries); when AI is available a background pass may refine the
 * primary-contact pick (never for restricted deals). Never throws: a failed enrichment leaves the deal as created.
 */
export async function enrichNewDeal(user: AppUser, dealId: string): Promise<{ autofill: Autofill; refine: (() => Promise<void>) | null }> {
  try {
    const [row] = await db
      .select({ deal: s.deals, unit: s.pipelines.unit, accountPriority: s.accounts.priority, accountSource: s.accounts.source, marketCapUsd: s.accounts.marketCapUsd })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(eq(s.deals.id, dealId));
    if (!row) return { autofill: {}, refine: null };
    const d = row.deal;
    const now = new Date();
    const at = now.toISOString();
    const fill: Autofill = {};
    const patch: Partial<typeof s.deals.$inferInsert> = {};

    if (!d.priority) {
      const p = suggestPriority({ accountPriority: row.accountPriority, unit: row.unit, muu: d.muu, contractValueCents: d.contractValueCents, marketCapUsd: row.marketCapUsd });
      if (p) {
        patch.priority = p.value;
        fill.priority = { value: p.value, label: p.label, reason: p.reason, engine: "heuristic", at };
      }
    }
    if (!d.expectedCloseDate) {
      const stages = (await getStagesByPipeline())[d.pipelineId] ?? [];
      const c = expectedCloseFromSla(stages, d.stageId, now);
      if (c) {
        patch.expectedCloseDate = c.value;
        fill.expectedCloseDate = { value: c.value.toISOString(), label: c.label, reason: c.reason, engine: "heuristic", at };
      }
    }
    let candidates: Awaited<ReturnType<typeof contactCandidates>> = [];
    if (!d.primaryContactId && d.accountId) {
      candidates = await contactCandidates(user, d.accountId);
      const pc = pickPrimaryContact(candidates, now);
      if (pc) {
        patch.primaryContactId = pc.value;
        fill.primaryContactId = { value: pc.value, label: pc.label, reason: pc.reason, engine: "heuristic", at };
      }
    }
    if (!d.source || d.source === "manual") {
      const [inbound] = d.accountId
        ? await db.execute<{ x: number }>(sql`select 1 as x from rso.email_messages m join rso.email_threads t on t.id = m.thread_id
            where t.account_id = ${d.accountId} and t.private = false and m.direction = 'inbound' and m.sent_at > now() - interval '90 days' limit 1`)
        : [];
      const picklist = (await getPicklist("source")).map((p) => p.value);
      const sg = suggestSource({ accountSource: row.accountSource, inboundEmail: !!inbound, role: user.role, picklist });
      if (sg) {
        patch.source = sg.value;
        fill.source = { value: sg.value, label: sg.label, reason: sg.reason, engine: "heuristic", at };
      }
    }
    if (!Object.keys(fill).length) return { autofill: {}, refine: null };
    patch.customFields = { ...(d.customFields ?? {}), [AUTOFILL_KEY]: { ...readAutofill(d.customFields), ...fill } };
    await db.transaction(async (tx) => {
      await tx.update(s.deals).set(patch).where(eq(s.deals.id, d.id));
      if (patch.primaryContactId) await tx.insert(s.dealContacts).values({ dealId: d.id, contactId: patch.primaryContactId, role: null }).onConflictDoNothing();
      await audit({ actorId: user.id, actorKind: "agent", action: "deal.autofill", entity: "deal", entityId: d.id, after: Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, { value: v.value, reason: v.reason }])) }, tx);
    });
    await recomputeDealHealth(d.id).catch((e) => logServerError("autofill.health", e));

    const refine =
      fill.primaryContactId && candidates.length >= 2 && !d.restricted && aiAvailable() && (await can(user, "copilot", "use_ai"))
        ? () => refinePrimaryContact(user, d.id, fill.primaryContactId!.value, candidates)
        : null;
    return { autofill: fill, refine };
  } catch (e) {
    logServerError("deal.autofill", e);
    return { autofill: {}, refine: null };
  }
}

async function contactCandidates(user: AppUser, accountId: string) {
  const where = await contactVisibilityWhere(user);
  return db
    .select({
      id: s.contacts.id,
      name: s.contacts.fullName,
      title: s.contacts.title,
      status: s.contacts.status,
      doNotContact: s.contacts.doNotContact,
      lastContactedAt: s.contacts.lastContactedAt,
      lastEmailAt: sql<Date | null>`(select max(m.sent_at) from rso.email_messages m join rso.email_threads t on t.id = m.thread_id
        where t.account_id = ${accountId} and t.private = false and ${s.contacts.email} is not null and position(lower(${s.contacts.email}) in lower(coalesce(m.from_addr, ''))) > 0)`,
    })
    .from(s.contacts)
    .where(and(eq(s.contacts.accountId, accountId), isNull(s.contacts.deletedAt), where))
    .limit(50);
}

/** Background AI pass: pick the best primary contact from the same candidates; only replaces the heuristic pick if untouched. */
async function refinePrimaryContact(user: AppUser, dealId: string, heuristicId: string, candidates: Awaited<ReturnType<typeof contactCandidates>>) {
  try {
    const list = candidates.filter((c) => c.status !== "left_company" && !c.doNotContact).slice(0, 25);
    const out = await aiObject({
      kind: "deal_autofill_contact",
      userId: user.id,
      tier: "fast",
      schema: z.object({ contactId: z.string(), reason: z.string() }),
      prompt: [
        "Pick the best primary contact for a new B2B sales deal: the decision maker we are most actively talking to.",
        "Return contactId from the list (exactly as given) and a 3-8 word reason.",
        ...list.map((c) => `- ${c.id}: ${c.name}${c.title ? `, ${c.title}` : ""}; last contacted ${c.lastContactedAt ? new Date(c.lastContactedAt).toISOString().slice(0, 10) : "never"}; last email ${c.lastEmailAt ? new Date(c.lastEmailAt).toISOString().slice(0, 10) : "never"}`),
      ].join("\n"),
    });
    const pick = list.find((c) => c.id === out.contactId);
    if (!pick || pick.id === heuristicId) return;
    const [d] = await db.select({ primaryContactId: s.deals.primaryContactId, customFields: s.deals.customFields }).from(s.deals).where(eq(s.deals.id, dealId));
    const marks = readAutofill(d?.customFields);
    if (!d || d.primaryContactId !== heuristicId || marks.primaryContactId?.value !== heuristicId) return; // the rep changed it
    const entry = { value: pick.id, label: pick.name, reason: out.reason.slice(0, 120), engine: `ai:${await modelFor("fast")}`, at: new Date().toISOString() };
    await db.transaction(async (tx) => {
      await tx
        .update(s.deals)
        .set({ primaryContactId: pick.id, customFields: { ...(d.customFields ?? {}), [AUTOFILL_KEY]: { ...marks, primaryContactId: entry } } })
        .where(and(eq(s.deals.id, dealId), eq(s.deals.primaryContactId, heuristicId)));
      await tx.insert(s.dealContacts).values({ dealId, contactId: pick.id, role: null }).onConflictDoNothing();
      await audit({ actorId: user.id, actorKind: "agent", action: "deal.autofill", entity: "deal", entityId: dealId, before: { primaryContactId: heuristicId }, after: { primaryContactId: pick.id, engine: entry.engine } }, tx);
    });
  } catch (e) {
    logServerError("deal.autofill.ai", e);
  }
}

/** Fields whose auto marker must go when a person sets them by hand. */
export function autofillFieldsTouched(patch: Record<string, unknown>): AutofillField[] {
  return (["priority", "expectedCloseDate", "primaryContactId", "source"] as const).filter((f) => patch[f] !== undefined);
}
