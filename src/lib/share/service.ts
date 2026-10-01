import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { isAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { dealAccessWhere, ForbiddenError, getHiddenFields, type AppUser } from "@/lib/rbac/server";
import { appUserById } from "@/lib/slack/identity";
import {
  expiryFrom,
  generateShareToken,
  hashShareToken,
  isWellFormedToken,
  linkState,
  MAX_SHARE_DEALS,
  normalizeShareFields,
  projectShareCard,
  SHARE_FIELD_SOURCES,
  type LinkState,
  type ShareCard,
  type ShareField,
} from "./core";

/** Fields the user's role may not see (field-level security) can't be shared either. */
async function allowedFieldsFor(user: AppUser): Promise<Set<ShareField>> {
  const hidden = await getHiddenFields(user.role, "deal");
  const out = new Set<ShareField>();
  if (hidden.has("*")) return out;
  for (const [f, cols] of Object.entries(SHARE_FIELD_SOURCES) as [ShareField, string[]][]) if (!cols.some((c) => hidden.has(c))) out.add(f);
  return out;
}

export async function shareableFields(user: AppUser): Promise<ShareField[]> {
  return [...(await allowedFieldsFor(user))];
}

/**
 * Can `user` share these deals? Only deals they can EDIT (owners/teams/leaders — not mere viewers), never restricted
 * ones (whatever the access list says), never deleted ones.
 */
async function shareableDeals(user: AppUser, dealIds: string[]) {
  const where = await dealAccessWhere(user, "edit");
  const rows = await db
    .select({ id: s.deals.id, dealRestricted: s.deals.restricted, accountRestricted: s.accounts.restricted })
    .from(s.deals)
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(inArray(s.deals.id, dealIds), where));
  return rows.map((r) => ({ id: r.id, restricted: r.dealRestricted || Boolean(r.accountRestricted) }));
}

/** Whether to show the share button for a deal (cheap: one query). */
export async function canShareDeal(user: AppUser, dealId: string): Promise<boolean> {
  if (user.impersonatedBy) return false;
  const [d] = await shareableDeals(user, [dealId]);
  return Boolean(d && !d.restricted);
}

export type CreateShareInput = { dealIds: string[]; label: string; partnerName?: string | null; fields: string[]; expiryDays: number };

/**
 * Create a link. Returns the full URL exactly once — only sha256(token) is stored.
 * One deal: refused outright when restricted or not editable. A list (QA MAJ-17, "share a filtered view"): restricted
 * and non-editable deals are left out and counted in `skipped`; refused only when nothing is left.
 */
export async function createShareLink(user: AppUser, input: CreateShareInput): Promise<{ id: string; url: string; expiresAt: string; skipped: number }> {
  if (user.impersonatedBy) throw new ForbiddenError("Partner links can't be created while viewing as another user.");
  const requested = Array.from(new Set(input.dealIds));
  if (!requested.length) throw new UserError("Pick at least one deal.");
  if (requested.length > MAX_SHARE_DEALS) throw new UserError(`A link can include at most ${MAX_SHARE_DEALS} deals.`);
  const rows = await shareableDeals(user, requested);
  if (requested.length === 1) {
    if (rows.some((r) => r.restricted)) throw new UserError("Restricted (MNPI) deals can never be shared outside Roundtable.");
    if (rows.length !== 1) throw new ForbiddenError("You can only share deals you can edit.");
  }
  const ok = new Set(rows.filter((r) => !r.restricted).map((r) => r.id));
  const ids = requested.filter((id) => ok.has(id));
  if (!ids.length) throw new UserError("None of these deals can be shared — restricted (MNPI) deals and deals you can't edit are left out.");
  const skipped = requested.length - ids.length;

  const allowed = await allowedFieldsFor(user);
  const fields = normalizeShareFields(input.fields);
  if (!fields.length) throw new UserError("Pick at least one field to share.");
  if (fields.some((f) => !allowed.has(f))) throw new ForbiddenError("You can't share a field your role can't see.");

  const label = input.label.trim().slice(0, 120);
  if (!label) throw new UserError("Give the link a name, e.g. “Arena — NET status”.");
  const token = generateShareToken();
  const expiresAt = expiryFrom(input.expiryDays);
  const [row] = await db
    .insert(s.shareLinks)
    .values({
      tokenHash: hashShareToken(token),
      label,
      partnerName: input.partnerName?.trim().slice(0, 120) || null,
      dealIds: ids,
      fields,
      createdBy: user.id,
      expiresAt,
    })
    .returning({ id: s.shareLinks.id });
  await audit({
    actorId: user.id,
    action: "share_link.create",
    entity: "share_link",
    entityId: row!.id,
    after: { label, partnerName: input.partnerName ?? null, dealIds: ids, fields, expiresAt, skipped },
  });
  return { id: row!.id, url: `${env.appUrl.replace(/\/$/, "")}/share/${token}`, expiresAt: expiresAt.toISOString(), skipped };
}

export async function revokeShareLink(user: AppUser, id: string): Promise<void> {
  const [link] = await db.select().from(s.shareLinks).where(eq(s.shareLinks.id, id));
  if (!link) throw new UserError("Link not found.");
  if (link.createdBy !== user.id && !(await isAdmin(user))) throw new ForbiddenError("Only the link's creator or an admin can revoke it.");
  if (user.impersonatedBy) throw new ForbiddenError("Links can't be revoked while viewing as another user.");
  const [after] = await db
    .update(s.shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.shareLinks.id, id), isNull(s.shareLinks.revokedAt)))
    .returning();
  if (!after) return; // already revoked: idempotent
  await audit({ actorId: user.id, action: "share_link.revoke", entity: "share_link", entityId: id, before: { revokedAt: null }, after: { revokedAt: after.revokedAt } });
}

export type ShareLinkView = {
  id: string;
  label: string;
  partnerName: string | null;
  dealCount: number;
  fields: string[];
  state: LinkState;
  expiresAt: string;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  creatorName: string | null;
  mine: boolean;
  canRevoke: boolean;
};

/** Links the user created (admins: everyone's), optionally only those including `dealId`. Newest first. */
export async function listShareLinks(user: AppUser, opts: { dealId?: string; limit?: number } = {}): Promise<ShareLinkView[]> {
  const admin = await isAdmin(user);
  const conds = [];
  if (!admin) conds.push(eq(s.shareLinks.createdBy, user.id));
  if (opts.dealId) conds.push(sql`${opts.dealId}::uuid = any(${s.shareLinks.dealIds})`);
  const rows = await db
    .select({ l: s.shareLinks, creatorName: s.user.name })
    .from(s.shareLinks)
    .leftJoin(s.user, eq(s.user.id, s.shareLinks.createdBy))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(s.shareLinks.createdAt))
    .limit(opts.limit ?? 50);
  const now = new Date();
  return rows.map(({ l, creatorName }) => ({
    id: l.id,
    label: l.label,
    partnerName: l.partnerName,
    dealCount: l.dealIds.length,
    fields: l.fields,
    state: linkState(l, now),
    expiresAt: l.expiresAt.toISOString(),
    createdAt: l.createdAt.toISOString(),
    viewCount: l.viewCount,
    lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
    creatorName,
    mine: l.createdBy === user.id,
    canRevoke: !l.revokedAt && (l.createdBy === user.id || admin),
  }));
}

/* ───────────── Public resolution (/share/[token]) ───────────── */

export type PublicShare = { label: string; partnerName: string | null; cards: ShareCard[]; expiresAt: string; asOf: string };

/**
 * Resolve a public token. Returns null for every failure (malformed, unknown, revoked, expired, creator no longer
 * active) so the page can't be used as an oracle. Re-applies at render time: restricted/deleted deals are dropped,
 * deals the creator can no longer edit are dropped, fields the creator's role can no longer see are dropped. The page
 * never says how many were dropped (that alone would tell a partner something was withdrawn or restricted).
 * Counts the view and audits it.
 */
export async function resolvePublicShare(token: string): Promise<PublicShare | null> {
  if (!isWellFormedToken(token)) return null;
  const [link] = await db.select().from(s.shareLinks).where(eq(s.shareLinks.tokenHash, hashShareToken(token)));
  if (!link || linkState(link) !== "active") return null;
  const creator = await appUserById(link.createdBy);
  if (!creator) return null;

  const allowed = await allowedFieldsFor(creator);
  const fields = normalizeShareFields(link.fields).filter((f) => allowed.has(f));
  const ids = link.dealIds.slice(0, MAX_SHARE_DEALS);
  // SEC L-12: resolve with the same scope creation required (edit), so a creator who lost edit rights stops sharing.
  const access = await dealAccessWhere(creator, "edit");
  const rows = ids.length
    ? await db
        .select({
          name: s.deals.name,
          accountName: s.accounts.name,
          restricted: s.deals.restricted,
          deletedAt: s.deals.deletedAt,
          status: s.deals.status,
          stageName: s.stages.name,
          stageCategory: s.stages.category,
          nextStep: s.deals.nextStep,
          nextStepDueAt: s.deals.nextStepDueAt,
          expectedCloseDate: s.deals.expectedCloseDate,
          muu: s.deals.muu,
          ownerName: s.user.name,
          accountRestricted: s.accounts.restricted,
        })
        .from(s.deals)
        .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
        .where(and(inArray(s.deals.id, ids), access))
        .orderBy(s.deals.name)
    : [];
  const tz = creator.timezone;
  const cards: ShareCard[] = [];
  for (const r of rows) {
    const card = projectShareCard(
      { ...r, restricted: r.restricted || Boolean(r.accountRestricted), deleted: Boolean(r.deletedAt), status: String(r.status) },
      fields,
      tz,
    );
    if (card) cards.push(card);
  }

  await db
    .update(s.shareLinks)
    .set({ viewCount: sql`${s.shareLinks.viewCount} + 1`, lastViewedAt: new Date() })
    .where(eq(s.shareLinks.id, link.id));
  await audit({ actorId: null, actorKind: "system", action: "share_link.view", entity: "share_link", entityId: link.id, after: { shown: cards.length } }).catch(() => undefined);

  return {
    label: link.label,
    partnerName: link.partnerName,
    cards,
    expiresAt: link.expiresAt.toISOString(),
    asOf: new Date().toISOString(),
  };
}
