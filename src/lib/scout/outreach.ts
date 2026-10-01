import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor } from "@/lib/ai";
import { accountVisibilityWhere } from "@/lib/accounts/queries";
import { can, type AppUser } from "@/lib/rbac/server";
import { suppressedEmails } from "./crm-match";
import { heuristicOpener, MAX_BATCH, openerPrompt, sanitizeOpener, type OpenerInput } from "./outreach-core";
import { MANAGER_ROLES } from "./queries";

/**
 * Lead Scout → outreach batch (V2 §A3): enriched executives of accepted targets with a usable email, not yet in any
 * sequence, with a personal opener per contact stored in `briefs` (kind "opener", subject = enriched_contacts.id,
 * audience = the rep). Nothing here sends anything (SCOUT-25): the rep approves the batch explicitly.
 */
export type OutreachRow = {
  id: string; // enriched_contacts.id
  fullName: string;
  title: string | null;
  email: string;
  verification: string;
  accountId: string;
  accountName: string;
  domain: string | null;
  fitScore: number | null;
  estMuu: number | null;
  promotedContactId: string | null;
  opener: string | null;
  engine: string | null;
  edited: boolean;
};

type BriefContent = { opener?: string; engine?: string; edited?: boolean; dismissed?: boolean; approvedAt?: string };

/** Up to `limit` (≤ 20) reviewable contacts for the rep, best fit first. */
export async function listOutreachBatch(user: AppUser, limit = MAX_BATCH): Promise<{ rows: OutreachRow[]; more: boolean }> {
  const take = Math.min(MAX_BATCH, Math.max(1, limit));
  const visibleAccount = await accountVisibilityWhere(user);
  const mineOnly = !MANAGER_ROLES.includes(user.role);
  const rows = await db
    .select({
      ec: s.enrichedContacts,
      accountName: s.accounts.name,
      domain: s.accounts.domain,
      accountMuu: s.accounts.muu,
      accountFit: s.accounts.fitScore,
      brief: s.briefs.content,
      engine: s.briefs.engine,
    })
    .from(s.enrichedContacts)
    .innerJoin(s.enrichmentRuns, eq(s.enrichmentRuns.id, s.enrichedContacts.runId))
    .innerJoin(s.accounts, eq(s.accounts.id, s.enrichedContacts.accountId))
    .leftJoin(s.briefs, and(eq(s.briefs.kind, "opener"), eq(s.briefs.subjectId, sql`${s.enrichedContacts.id}::text`), eq(s.briefs.userId, user.id), eq(s.briefs.periodKey, "")))
    .where(
      and(
        inArray(s.enrichedContacts.state, ["staged", "promoted"]),
        isNotNull(s.enrichedContacts.email),
        inArray(s.enrichedContacts.verification, ["valid", "risky"]),
        ne(sql`coalesce(${s.enrichedContacts.title}, '')`, "Generic inbox"),
        mineOnly ? eq(s.enrichmentRuns.requestedBy, user.id) : sql`true`,
        isNull(s.accounts.deletedAt),
        eq(s.accounts.doNotContact, false),
        visibleAccount,
        sql`coalesce((${s.briefs.content}->>'dismissed')::boolean, false) = false`,
        // never re-offer someone who is (or was) in a sequence, or a contact flagged do-not-contact
        notExists(
          db
            .select({ x: sql`1` })
            .from(s.contacts)
            .where(
              and(
                sql`(${s.contacts.id} = ${s.enrichedContacts.promotedContactId} or lower(${s.contacts.email}) = lower(${s.enrichedContacts.email}))`,
                isNull(s.contacts.deletedAt),
                sql`(${s.contacts.doNotContact} or exists (select 1 from ${s.sequenceEnrollments} se where se.contact_id = ${s.contacts.id}))`,
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`${s.accounts.fitScore} desc nulls last`, desc(s.enrichedContacts.createdAt))
    .limit(take * 3 + 1);
  // suppression list + one row per email
  const supp = await suppressedEmails(rows.map((r) => r.ec.email!).filter(Boolean));
  const seen = new Set<string>();
  const out: OutreachRow[] = [];
  for (const r of rows) {
    const email = r.ec.email!.toLowerCase();
    if (supp.has(email) || seen.has(email)) continue;
    seen.add(email);
    const b = (r.brief ?? null) as BriefContent | null;
    out.push({
      id: r.ec.id,
      fullName: r.ec.fullName,
      title: r.ec.title,
      email,
      verification: r.ec.verification,
      accountId: r.ec.accountId!,
      accountName: r.accountName,
      domain: r.domain,
      fitScore: r.accountFit,
      estMuu: r.accountMuu,
      promotedContactId: r.ec.promotedContactId,
      opener: b?.opener ?? null,
      engine: r.engine ?? null,
      edited: Boolean(b?.edited),
    });
  }
  return { rows: out.slice(0, take), more: out.length > take };
}

/** Rows the user may act on (own runs unless manager; account visible). */
export async function loadOutreachRows(user: AppUser, ids: string[]) {
  const visibleAccount = await accountVisibilityWhere(user);
  const rows = await db
    .select({ ec: s.enrichedContacts, requestedBy: s.enrichmentRuns.requestedBy, account: s.accounts })
    .from(s.enrichedContacts)
    .innerJoin(s.enrichmentRuns, eq(s.enrichmentRuns.id, s.enrichedContacts.runId))
    .innerJoin(s.accounts, eq(s.accounts.id, s.enrichedContacts.accountId))
    .where(and(inArray(s.enrichedContacts.id, ids), visibleAccount));
  const manager = MANAGER_ROLES.includes(user.role);
  return rows.filter((r) => manager || r.requestedBy === user.id);
}

async function openerInputFor(ec: typeof s.enrichedContacts.$inferSelect, account: typeof s.accounts.$inferSelect): Promise<OpenerInput> {
  const [cand] = account.domain
    ? await db
        .select()
        .from(s.scoutCandidates)
        .where(and(eq(s.scoutCandidates.domain, account.domain), eq(s.scoutCandidates.state, "accepted")))
        .orderBy(desc(s.scoutCandidates.reviewedAt))
        .limit(1)
    : [];
  const raw = (cand?.raw ?? {}) as Record<string, unknown>;
  return {
    contactName: ec.fullName,
    contactTitle: ec.title,
    company: account.name,
    domain: account.domain,
    category: cand?.category ?? account.category,
    estMuu: cand?.estMuu ?? account.muu,
    trendPct: cand?.trendPct ?? null,
    techStack: cand?.techStack ?? account.techStack ?? [],
    displaceable: Array.isArray(raw.displaceable) ? (raw.displaceable as unknown[]).filter((x): x is string => typeof x === "string") : [],
    ownership: cand?.ownership ?? account.ownership,
    fitExplanation: cand?.fitExplanation ?? account.fitExplanation,
    serpTitle: typeof raw.serpTitle === "string" ? raw.serpTitle : null,
  };
}

const openerSchema = z.object({ opener: z.string().max(600) });

/** Generate (or regenerate) openers; AI when available with a heuristic fallback. Stored per rep in `briefs`. */
export async function generateOpeners(user: AppUser, ids: string[], opts: { force?: boolean } = {}): Promise<{ generated: number; engine: string }> {
  const rows = await loadOutreachRows(user, ids.slice(0, MAX_BATCH));
  const existing = new Map(
    (
      await db
        .select({ subjectId: s.briefs.subjectId, content: s.briefs.content })
        .from(s.briefs)
        .where(and(eq(s.briefs.kind, "opener"), eq(s.briefs.userId, user.id), inArray(s.briefs.subjectId, rows.map((r) => r.ec.id))))
    ).map((b) => [b.subjectId, b.content as BriefContent]),
  );
  const todo = rows.filter((r) => opts.force || !existing.get(r.ec.id)?.opener);
  // SEC M-6: AI only with copilot.use_ai; restricted (MNPI) accounts never go to the model — heuristic opener instead
  const useAi = aiAvailable() && (await can(user, "copilot", "use_ai"));
  const model = useAi ? await modelFor("fast") : null;
  let lastEngine = "heuristic";
  let generated = 0;
  for (let i = 0; i < todo.length; i += 4) {
    const chunk = todo.slice(i, i + 4);
    await Promise.all(
      chunk.map(async ({ ec, account }) => {
        const input = await openerInputFor(ec, account);
        let opener = "";
        let engine = "heuristic";
        if (useAi && !account.restricted) {
          try {
            const r = await aiObject({ kind: "scout_opener", userId: user.id, tier: "fast", prompt: openerPrompt(input), schema: openerSchema, maxOutputTokens: 400 });
            opener = sanitizeOpener(r.opener);
            if (opener) engine = `ai:${model}`;
          } catch {
            /* fall through to heuristic */
          }
        }
        if (!opener) opener = sanitizeOpener(heuristicOpener(input));
        lastEngine = engine;
        const content: BriefContent = { opener, engine, edited: false };
        await db
          .insert(s.briefs)
          .values({ kind: "opener", subjectId: ec.id, userId: user.id, periodKey: "", content, engine })
          .onConflictDoUpdate({ target: [s.briefs.kind, s.briefs.subjectId, s.briefs.userId, s.briefs.periodKey], set: { content, engine, createdAt: new Date() } });
        generated++;
      }),
    );
  }
  return { generated, engine: lastEngine };
}

export async function saveOpenerBrief(userId: string, enrichedContactId: string, patch: BriefContent) {
  const [cur] = await db
    .select({ content: s.briefs.content, engine: s.briefs.engine })
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, "opener"), eq(s.briefs.subjectId, enrichedContactId), eq(s.briefs.userId, userId), eq(s.briefs.periodKey, "")));
  const content = { ...((cur?.content ?? {}) as BriefContent), ...patch };
  await db
    .insert(s.briefs)
    .values({ kind: "opener", subjectId: enrichedContactId, userId, periodKey: "", content, engine: cur?.engine ?? "manual" })
    .onConflictDoUpdate({ target: [s.briefs.kind, s.briefs.subjectId, s.briefs.userId, s.briefs.periodKey], set: { content } });
}

/** Stored openers (this rep's drafts) for enriched contacts — used to tell a real edit from an untouched draft. */
export async function storedOpeners(userId: string, enrichedContactIds: string[]): Promise<Map<string, string>> {
  if (!enrichedContactIds.length) return new Map();
  const rows = await db
    .select({ subjectId: s.briefs.subjectId, content: s.briefs.content })
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, "opener"), eq(s.briefs.userId, userId), eq(s.briefs.periodKey, ""), inArray(s.briefs.subjectId, enrichedContactIds)));
  return new Map(rows.map((r) => [r.subjectId, ((r.content ?? {}) as BriefContent).opener ?? ""]));
}
