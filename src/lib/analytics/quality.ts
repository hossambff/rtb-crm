import "server-only";
import { limitedAll } from "./limit";
import { and, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { ownedEntityWhere } from "@/lib/rbac/server";
import { getSetting } from "@/lib/settings";
import { accountVisibleWhere, dealScopeWhere, ownerFilter, type AnalyticsContext } from "./scope";
import { EMAIL_PATTERN_SQL, unmappedFromStats } from "./transforms";
import { countInt } from "./value-sql";

/**
 * Data Quality (PRD §14.2): duplicates, missing MUU on engaged deals, missing primary contact, invalid emails,
 * unmapped import statuses. Everything is scoped (accounts/contacts by owner scope, deals by deal access).
 */
export async function dataQuality(ctx: AnalyticsContext) {
  const threshold = await getSetting<number>("pipeline.engaged_threshold", 0.5);
  const dealWhere = await dealScopeWhere(ctx);
  const acctAccess = await ownedEntityWhere(ctx.user, "accounts", "view", s.accounts.ownerId);
  const contactAccess = await ownedEntityWhere(ctx.user, "contacts", "view", s.contacts.ownerId);
  const acctScope = and(acctAccess, isNull(s.accounts.deletedAt), accountVisibleWhere(ctx.user), ownerFilter(ctx, s.accounts.ownerId));
  const contactScope = and(contactAccess, isNull(s.contacts.deletedAt), ownerFilter(ctx, s.contacts.ownerId));
  const open = eq(s.stages.category, "open");

  // Correlated columns are written out: drizzle leaves single-table columns unqualified, which would bind to `b`.
  const altDup = sql`exists (select 1 from ${s.accounts} b where b.id <> "accounts".id and b.deleted_at is null and "accounts".domain = any(b.alt_domains))`;
  const nameKey = sql<string>`lower(btrim(${s.accounts.name}))`;

  const [domainDupes, nameDupes, emailDupes, missingMuu, missingContact, emails, imports, missingDomain] = await limitedAll([
    db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain })
      .from(s.accounts)
      .where(and(acctScope, isNotNull(s.accounts.domain), altDup))
      .limit(50),
    db
      .select({ key: nameKey, n: countInt, sample: sql<string>`min(${s.accounts.name})`, domains: sql<string>`string_agg(coalesce(${s.accounts.domain}, '—'), ', ')` })
      .from(s.accounts)
      .where(acctScope)
      .groupBy(nameKey)
      .having(sql`count(*) > 1`)
      .orderBy(desc(countInt))
      .limit(50),
    db
      .select({ email: sql<string>`lower(${s.contacts.email})`, n: countInt })
      .from(s.contacts)
      .where(and(contactScope, isNotNull(s.contacts.email), ne(s.contacts.email, "")))
      .groupBy(sql`lower(${s.contacts.email})`)
      .having(sql`count(*) > 1`)
      .orderBy(desc(countInt))
      .limit(50),
    db
      .select({ id: s.deals.id, name: s.deals.name, pipeline: s.pipelines.key, stage: s.stages.name })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(dealWhere, open, eq(s.pipelines.unit, "muu"), gte(s.stages.probability, threshold), or(isNull(s.deals.muu), lte(s.deals.muu, 0))))
      .limit(500),
    db
      .select({ n: countInt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(dealWhere, open, isNull(s.deals.primaryContactId))),
    db
      .select({
        id: s.contacts.id,
        name: s.contacts.fullName,
        email: s.contacts.email,
        status: s.contacts.emailStatus,
        total: sql<number>`(count(*) over ())::int`,
      })
      .from(s.contacts)
      .where(and(contactScope, isNotNull(s.contacts.email), ne(s.contacts.email, ""), or(eq(s.contacts.emailStatus, "invalid"), sql`btrim(${s.contacts.email}) !~* ${EMAIL_PATTERN_SQL}`)))
      .limit(25),
    db
      .select({ id: s.importBatches.id, fileName: s.importBatches.fileName, sheet: s.importBatches.sheetName, target: s.importBatches.target, stats: s.importBatches.stats, createdAt: s.importBatches.createdAt })
      .from(s.importBatches)
      .where(and(ne(s.importBatches.status, "rolled_back"), gte(s.importBatches.createdAt, ctx.filters.from), ctx.scope === "all" ? sql`true` : eq(s.importBatches.createdBy, ctx.user.id)))
      .orderBy(desc(s.importBatches.createdAt))
      .limit(200),
    db
      .select({ n: countInt })
      .from(s.accounts)
      .where(and(acctScope, isNull(s.accounts.domain))),
  ]);

  const importRows = imports.map((b) => ({ ...b, unmapped: unmappedFromStats(b.stats) })).filter((b) => b.unmapped > 0);
  return {
    threshold,
    domainDupes,
    nameDupes,
    emailDupes,
    missingMuu,
    missingContact: missingContact[0]?.n ?? 0,
    invalidEmails: { count: emails[0]?.total ?? 0, sample: emails.map((c) => ({ id: c.id, name: c.name, email: c.email, status: c.status })) },
    unmapped: { count: importRows.reduce((a, b) => a + b.unmapped, 0), batches: importRows.slice(0, 25) },
    missingDomain: missingDomain[0]?.n ?? 0,
  };
}
