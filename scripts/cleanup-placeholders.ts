/**
 * QA-20 post-import cleanup (idempotent; re-running is a no-op).
 *
 * 1. Non-person placeholder owners. The spreadsheet import turned every unknown owner token into a placeholder user
 *    (`<token>.placeholder@roundtable.invalid`). Tokens that are not one of the known reps (src/lib/import/owners.ts
 *    KNOWN_REPS) — e.g. "News", "Politics", "Zed" — are category words / noise, not people. Their records are set to
 *    unassigned (owner_id = null), their deal-split rows are removed when the deal has other splits (a sole 100% split
 *    is left and reported), and the user stays banned with an explicit ban reason so no picker offers it.
 * 2. "9F Inc." was imported with domain facebook.com (a social link, not its website), which blocks dedupe for a real
 *    Facebook/Meta account. The domain/website are cleared and a note explains why.
 *
 * Every change is audit-logged (actor "system:cleanup"). Usage: npx tsx scripts/cleanup-placeholders.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { KNOWN_REPS } from "../src/lib/import/owners";

const ACTOR = "system:cleanup";
const BAN_REASON = "Non-person owner string from the spreadsheet import (QA-20) — not a rep; hidden from owner pickers";
const FB_NOTE =
  "Domain cleared 30 Sep 2026 (QA-20): the import set facebook.com (a social link, not 9F's website), which blocked dedupe for the real Facebook/Meta account. Add the real domain when known.";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, close } = scriptDb();
  const log: Record<string, unknown>[] = [];
  try {
    const known = new Set(Object.keys(KNOWN_REPS).map((k) => k.toLowerCase()));
    const placeholders = await db
      .select({ id: s.user.id, name: s.user.name, email: s.user.email, banned: s.user.banned, banReason: s.user.banReason })
      .from(s.user)
      .where(like(s.user.email, "%.placeholder@roundtable.invalid"));
    const nonPerson = placeholders.filter((u) => !known.has(u.email.split(".placeholder@")[0]!.toLowerCase()));

    for (const u of nonPerson) {
      const deals = await db.select({ id: s.deals.id }).from(s.deals).where(and(eq(s.deals.ownerId, u.id), isNull(s.deals.deletedAt)));
      const accounts = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.ownerId, u.id), isNull(s.accounts.deletedAt)));
      const contacts = await db.select({ id: s.contacts.id }).from(s.contacts).where(and(eq(s.contacts.ownerId, u.id), isNull(s.contacts.deletedAt)));
      const splits = await db
        .select({ dealId: s.dealSplits.dealId, others: sql<number>`(select count(*)::int from rso.deal_splits x where x.deal_id = "deal_splits"."deal_id" and x.user_id <> ${u.id})` })
        .from(s.dealSplits)
        .where(eq(s.dealSplits.userId, u.id));
      const removable = splits.filter((x) => x.others > 0).map((x) => x.dealId);
      const soleSplits = splits.filter((x) => x.others === 0).map((x) => x.dealId);
      const needsBan = !u.banned || u.banReason !== BAN_REASON;
      const entry = { user: u.name, deals: deals.length, accounts: accounts.length, contacts: contacts.length, splitsRemoved: removable.length, soleSplitsKept: soleSplits, ban: needsBan };
      log.push(entry);
      if (dry || (!deals.length && !accounts.length && !contacts.length && !removable.length && !needsBan)) continue;

      await db.transaction(async (tx) => {
        if (deals.length) await tx.update(s.deals).set({ ownerId: null }).where(inArray(s.deals.id, deals.map((d) => d.id)));
        if (accounts.length) await tx.update(s.accounts).set({ ownerId: null }).where(inArray(s.accounts.id, accounts.map((a) => a.id)));
        if (contacts.length) await tx.update(s.contacts).set({ ownerId: null }).where(inArray(s.contacts.id, contacts.map((c) => c.id)));
        if (removable.length) await tx.delete(s.dealSplits).where(and(eq(s.dealSplits.userId, u.id), inArray(s.dealSplits.dealId, removable)));
        if (needsBan) await tx.update(s.user).set({ banned: true, banReason: BAN_REASON }).where(eq(s.user.id, u.id));
        await tx.insert(s.auditLog).values({
          actorId: ACTOR,
          actorKind: "system",
          action: "cleanup.placeholder_owner",
          entity: "user",
          entityId: u.id,
          before: { banned: u.banned, banReason: u.banReason } as never,
          after: { ...entry, dealIds: deals.map((d) => d.id), accountIds: accounts.map((a) => a.id), contactIds: contacts.map((c) => c.id), splitDealIds: removable } as never,
        });
      });
    }

    // 2) 9F Inc. → facebook.com
    const fb = await db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, website: s.accounts.website, notes: s.accounts.notes })
      .from(s.accounts)
      .where(and(eq(s.accounts.domain, "facebook.com"), sql`lower(${s.accounts.name}) like '9f%'`, isNull(s.accounts.deletedAt)));
    for (const a of fb) {
      log.push({ account: a.name, domain: a.domain, action: "clear domain" });
      if (dry) continue;
      await db.transaction(async (tx) => {
        await tx
          .update(s.accounts)
          .set({ domain: null, website: null, notes: a.notes ? `${a.notes}\n\n${FB_NOTE}` : FB_NOTE })
          .where(eq(s.accounts.id, a.id));
        await tx.insert(s.auditLog).values({
          actorId: ACTOR,
          actorKind: "system",
          action: "cleanup.account_domain",
          entity: "account",
          entityId: a.id,
          before: { domain: a.domain, website: a.website } as never,
          after: { domain: null, website: null, note: FB_NOTE } as never,
        });
      });
    }
    console.log(JSON.stringify({ dryRun: dry, placeholders: placeholders.length, nonPerson: nonPerson.map((u) => u.name), changes: log }, null, 2));
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
