"use server";
import { revalidatePath } from "next/cache";
import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { normalizeDomain, parseAudience } from "@/lib/domain";
import { getSetting } from "@/lib/settings";
import { assertCan, inScope, type AppUser } from "@/lib/rbac/server";
import { nameSimilarity, normalizeName } from "@/lib/import/dedupe";
import { mergeAccounts } from "./merge";
import { accountVisibilityWhere, getVisibleAccount, searchAccounts } from "./queries";

const ACCOUNT_TYPE = z.enum(["publisher", "media_group", "public_company", "token_project", "advertiser", "agency", "partner", "other"]);
const LIFECYCLE = z.enum(["target", "prospect", "customer", "churned", "disqualified"]);
const PRIORITY = z.enum(["top10", "high", "medium", "low"]);
const optText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export type DuplicateMatch = { id: string; name: string; domain: string | null; reason: "domain" | "name"; score: number; hidden?: boolean };

/** SEC M-1: shown instead of the name when the matching account isn't visible to the caller (restricted/out of scope). */
const HIDDEN_ACCOUNT_LABEL = "an existing account you don't have access to (ask an admin)";

async function findDuplicates(user: AppUser, name: string, domainRaw: string | null | undefined, excludeId?: string): Promise<DuplicateMatch[]> {
  const domain = normalizeDomain(domainRaw ?? null);
  const visible = await accountVisibilityWhere(user);
  const out: DuplicateMatch[] = [];
  if (domain) {
    // domain uniqueness is global: check all live accounts, not just visible ones
    const [hit] = await db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, visible: sql<boolean>`${visible}` })
      .from(s.accounts)
      .where(and(isNull(s.accounts.deletedAt), eq(s.accounts.domain, domain), excludeId ? ne(s.accounts.id, excludeId) : undefined));
    // SEC M-1: the existence of the domain is reported, but never the name/id of an account the caller can't see.
    if (hit)
      out.push(
        hit.visible
          ? { id: hit.id, name: hit.name, domain: hit.domain, reason: "domain", score: 1 }
          : { id: "hidden", name: HIDDEN_ACCOUNT_LABEL, domain: null, reason: "domain", score: 1, hidden: true },
      );
  }
  const n = normalizeName(name);
  if (n.length >= 3) {
    const COMMON = /^(the|daily|news|media|times|post|journal|group|inc|digital|network|online|magazine|report|today|world|global|sports?)$/i;
    const words = name.trim().split(/[\s/,.&-]+/).filter((w) => w.length >= 3);
    const token = words.find((w) => !COMMON.test(w)) ?? words[0] ?? name;
    const like = `%${token.replace(/[%_\\]/g, "\\$&").slice(0, 40)}%`;
    const rows = await db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain })
      .from(s.accounts)
      .where(and(visible, or(ilike(s.accounts.name, like), domain ? ilike(s.accounts.domain, `%${domain.split(".")[0]}%`) : undefined), excludeId ? ne(s.accounts.id, excludeId) : undefined))
      .limit(50);
    for (const r of rows) {
      if (out.some((o) => o.id === r.id)) continue;
      const score = nameSimilarity(name, r.name);
      if (score >= 0.7) out.push({ ...r, reason: "name", score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

export const checkAccountDuplicates = action(z.object({ name: z.string().trim().min(1).max(200), domain: z.string().trim().max(300).optional().nullable() }), async (input, user) => {
  await assertCan(user, "accounts", "view");
  return findDuplicates(user, input.name, input.domain);
});

const accountFields = {
  name: z.string().trim().min(1, "Name is required").max(200),
  domain: optText(300),
  type: ACCOUNT_TYPE,
  category: optText(80),
  subcategory: optText(120),
  lifecycle: LIFECYCLE,
  priority: PRIORITY.optional().nullable(),
  // SEC L-13: an omitted owner means "unchanged" (undefined), an explicit empty value means "unassigned" (null).
  ownerId: z
    .string()
    .trim()
    .max(80)
    .optional()
    .nullable()
    .transform((v) => (v === undefined ? undefined : v || null)),
  parentId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  country: optText(80),
  region: optText(80),
  language: optText(20),
  ownership: optText(120),
  league: optText(80),
  team: optText(120),
  ticker: optText(20),
  tokenName: optText(40),
  isB2c: z.boolean().optional().nullable(),
  marketCapUsd: z.number().int().nonnegative().optional().nullable(),
  pressPage: optText(500),
  prEmail: z.string().trim().email("Enter a valid email").optional().nullable().or(z.literal("").transform(() => null)),
  linkedinUrl: optText(500),
  techStack: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  notes: optText(5000),
  doNotContact: z.boolean().optional(),
};

function toRow(input: Partial<Record<keyof typeof accountFields, unknown>>) {
  const domain = input.domain ? normalizeDomain(String(input.domain)) : null;
  if (input.domain && !domain) throw new UserError(`“${input.domain}” is not a valid domain`);
  return { ...input, domain, website: domain ? `https://${domain}` : null } as Record<string, unknown>;
}

export const createAccount = action(z.object({ ...accountFields, force: z.boolean().optional() }), async (input, user) => {
  await assertCan(user, "accounts", "create");
  const { force, ...fields } = input;
  const row = toRow(fields);
  await assertVisibleParent(user, row.parentId as string | null | undefined);
  if (row.ownerId && row.ownerId !== user.id) await assertCan(user, "accounts", "assign");
  const dups = await findDuplicates(user, input.name, input.domain);
  const domainDup = dups.find((d) => d.reason === "domain");
  if (domainDup) throw new UserError(`An account with this domain already exists: ${domainDup.name}`);
  if (dups.length && !force) return { created: false as const, duplicates: dups };
  const [created] = await db
    .insert(s.accounts)
    .values({ ...(row as typeof s.accounts.$inferInsert), ownerId: (row.ownerId as string | null) ?? user.id, createdBy: user.id, source: "manual" })
    .returning();
  await audit({ actorId: user.id, action: "account.create", entity: "account", entityId: created!.id, after: created });
  revalidatePath("/accounts");
  return { created: true as const, id: created!.id };
});

/** SEC M-1: a parent must be an account the caller can see (no linking to — and later displaying — restricted ones). */
async function assertVisibleParent(user: AppUser, parentId: string | null | undefined) {
  if (!parentId) return;
  if (!(await getVisibleAccount(user, parentId))) throw new UserError("Parent account not found.");
}

async function loadEditable(user: AppUser, id: string) {
  const scope = await assertCan(user, "accounts", "edit");
  const account = await getVisibleAccount(user, id);
  if (!account || !inScope(user, scope, { ownerId: account.ownerId })) throw new UserError("You can't edit this account.");
  return account;
}

export const updateAccount = action(z.object({ id: z.string().uuid(), ...accountFields }), async (input, user) => {
  const before = await loadEditable(user, input.id);
  const { id, ...fields } = input;
  const row = toRow(fields);
  if (row.domain && row.domain !== before.domain) {
    const dups = await findDuplicates(user, input.name, row.domain as string, id);
    const d = dups.find((x) => x.reason === "domain");
    if (d) throw new UserError(`Domain already used by ${d.name} — merge the accounts instead.`);
  }
  if (row.parentId === id) throw new UserError("An account can't be its own parent.");
  if (row.parentId && row.parentId !== before.parentId) await assertVisibleParent(user, row.parentId as string);
  if (row.ownerId !== undefined && row.ownerId !== before.ownerId) await assertCan(user, "accounts", "assign");
  const [after] = await db.update(s.accounts).set(row as Partial<typeof s.accounts.$inferInsert>).where(eq(s.accounts.id, id)).returning();
  await audit({ actorId: user.id, action: "account.update", entity: "account", entityId: id, before, after });
  revalidatePath(`/accounts/${id}`);
  revalidatePath("/accounts");
  return { id };
});

export const mergeAccountInto = action(z.object({ targetId: z.string().uuid(), sourceId: z.string().uuid() }), async (input, user) => {
  if (input.targetId === input.sourceId) throw new UserError("Pick a different account to merge.");
  const target = await loadEditable(user, input.targetId);
  const source = await loadEditable(user, input.sourceId);
  // One transaction (H-10): row-locked merge + its audit entry commit together.
  const res = await db.transaction(async (tx) => {
    const r = await mergeAccounts(tx, { targetId: target.id, sourceId: source.id });
    await audit(
      {
        actorId: user.id,
        action: "account.merge",
        entity: "account",
        entityId: target.id,
        before: { target: r.targetBefore, source: { id: source.id, name: source.name, domain: source.domain, ...r.sourceBefore } },
        after: { mergedFrom: source.id, moved: Object.fromEntries(Object.entries(r.moved).map(([k, v]) => [k, v.length])) },
      },
      tx,
    );
    return r;
  });
  revalidatePath(`/accounts/${target.id}`);
  revalidatePath("/accounts");
  return { moved: Object.fromEntries(Object.entries(res.moved).map(([k, v]) => [k, v.length])) as Record<string, number> };
});

export const addAudienceMetric = action(
  z.object({
    accountId: z.string().uuid(),
    metric: z.enum(["muu", "visits", "pageviews"]),
    raw: z.string().trim().min(1, "Enter a value such as 450k or 1.5–2M").max(40),
    period: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM"),
    source: z.string().trim().min(1, "Source is required").max(80),
    confidence: z.enum(["verified", "reported", "estimate"]),
  }),
  async (input, user) => {
    const account = await loadEditable(user, input.accountId);
    const value = parseAudience(input.raw);
    if (value == null) throw new UserError(`Couldn't read “${input.raw}” as a number (try 450k, 1.2M, 1.5–2M).`);
    const factor = input.metric === "visits" ? await getSetting<number>("scout.visits_per_unique", 2.5) : null;
    const [m] = await db
      .insert(s.audienceMetrics)
      .values({
        accountId: account.id,
        metric: input.metric,
        value,
        rawValue: input.raw,
        derivedMuu: factor ? Math.round(value / factor) : null,
        factorUsed: factor,
        period: input.period,
        source: input.source,
        confidence: input.confidence,
        enteredBy: user.id,
      })
      .returning();
    // denormalized "latest" values on the account (latest period wins)
    const patch: Partial<typeof s.accounts.$inferInsert> = {};
    const latestOf = async (metric: "muu" | "visits") =>
      (
        await db
          .select({ period: s.audienceMetrics.period })
          .from(s.audienceMetrics)
          .where(and(eq(s.audienceMetrics.accountId, account.id), eq(s.audienceMetrics.metric, metric)))
          .orderBy(s.audienceMetrics.period)
      ).at(-1)?.period;
    if (input.metric === "muu" && (await latestOf("muu")) === input.period) Object.assign(patch, { muu: value, muuSource: input.source, muuConfidence: input.confidence });
    if (input.metric === "visits" && (await latestOf("visits")) === input.period) {
      patch.monthlyVisits = value;
      if (account.muu == null || account.muuConfidence === "estimate") Object.assign(patch, { muu: Math.round(value / (factor ?? 2.5)), muuSource: `${input.source} visits ÷ ${factor ?? 2.5}`, muuConfidence: "estimate" as const });
    }
    if (Object.keys(patch).length) await db.update(s.accounts).set(patch).where(eq(s.accounts.id, account.id));
    await audit({ actorId: user.id, action: "audience_metric.create", entity: "account", entityId: account.id, after: { metric: m, accountPatch: patch } });
    revalidatePath(`/accounts/${account.id}`);
    return { id: m!.id };
  },
);

export const searchAccountsAction = action(z.object({ q: z.string().trim().min(1).max(100) }), async (input, user) => {
  await assertCan(user, "accounts", "view");
  const hits = await searchAccounts(user, input.q, 10);
  if (!hits.length) return [];
  // QA-22: disambiguate same-name accounts in pickers (merge dialog) with owner + created date.
  const extra = await db
    .select({ id: s.accounts.id, createdAt: s.accounts.createdAt, ownerName: s.user.name })
    .from(s.accounts)
    .leftJoin(s.user, eq(s.user.id, s.accounts.ownerId))
    .where(inArray(s.accounts.id, hits.map((h) => h.id)));
  const byId = new Map(extra.map((e) => [e.id, e]));
  return hits.map((h) => ({ ...h, ownerName: byId.get(h.id)?.ownerName ?? null, createdAt: byId.get(h.id)?.createdAt.toISOString() ?? null }));
});
