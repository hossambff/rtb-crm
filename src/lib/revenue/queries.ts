import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { revenueDealWhere } from "./access";
import { arAging, concentration, daysOverdue, effectiveStatus, renewalsDue, revenueSummary, type AdsDeal, type InvoiceStatus } from "./calc";

export type InvoiceRow = {
  id: string;
  dealId: string;
  dealName: string;
  accountName: string | null;
  ownerName: string | null;
  amountCents: number;
  dueAt: string;
  status: InvoiceStatus;
  storedStatus: string;
  daysOverdue: number;
  paidAt: string | null;
  paidInKind: string | null;
  notes: string | null;
};

export type AdsDealRow = {
  id: string;
  name: string;
  accountName: string | null;
  ownerName: string | null;
  stageKey: string;
  stageName: string;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
  nextPaymentCents: number | null;
  nextPaymentAt: string | null;
  renewalAt: string | null;
  canEdit: boolean;
};

export async function getRevenueData(user: AppUser) {
  const now = new Date();
  const where = await revenueDealWhere(user, "view");
  const [ads] = await db.select().from(s.pipelines).where(eq(s.pipelines.key, "ADS"));

  const dealRows = ads
    ? await db
        .select({
          id: s.deals.id,
          name: s.deals.name,
          ownerId: s.deals.ownerId,
          teamId: s.deals.teamId,
          accountId: s.deals.accountId,
          accountName: s.accounts.name,
          ownerName: s.user.name,
          stageKey: s.stages.key,
          stageName: s.stages.name,
          stageOrder: s.stages.sortOrder,
          contractValueCents: s.deals.contractValueCents,
          annualizedValueCents: s.deals.annualizedValueCents,
          nextPaymentCents: s.deals.nextPaymentCents,
          nextPaymentAt: s.deals.nextPaymentAt,
          renewalAt: s.deals.renewalAt,
        })
        .from(s.deals)
        .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
        .where(and(where, eq(s.deals.pipelineId, ads.id)))
        .orderBy(asc(s.stages.sortOrder), asc(s.deals.name))
        .limit(3000)
    : [];

  const invRows = await db
    .select({
      id: s.invoices.id,
      dealId: s.invoices.dealId,
      dealName: s.deals.name,
      accountName: s.accounts.name,
      ownerName: s.user.name,
      amountCents: s.invoices.amountCents,
      dueAt: s.invoices.dueAt,
      status: s.invoices.status,
      paidAt: s.invoices.paidAt,
      paidInKind: s.invoices.paidInKind,
      notes: s.invoices.notes,
    })
    .from(s.invoices)
    .innerJoin(s.deals, eq(s.deals.id, s.invoices.dealId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
    .where(where)
    .orderBy(desc(s.invoices.dueAt))
    .limit(5000);

  const [canCreate, canEdit, canDelete, adsEditScope] = await Promise.all([
    can(user, "revenue", "create"),
    can(user, "revenue", "edit"),
    can(user, "revenue", "delete"),
    scopeFor(user, "deals_ADS", "edit"),
  ]);

  const adsDeals: AdsDeal[] = dealRows.map((d) => ({
    id: d.id,
    stageKey: d.stageKey,
    contractValueCents: d.contractValueCents,
    annualizedValueCents: d.annualizedValueCents,
    renewalAt: d.renewalAt,
    accountId: d.accountId,
    accountName: d.accountName ?? d.name,
    nextPaymentCents: d.nextPaymentCents,
    nextPaymentAt: d.nextPaymentAt,
  }));
  const invForCalc = invRows.map((i) => ({ status: i.status, dueAt: i.dueAt, amountCents: i.amountCents, dealId: i.dealId }));

  const invoices: InvoiceRow[] = invRows.map((i) => ({
    id: i.id,
    dealId: i.dealId,
    dealName: i.dealName,
    accountName: i.accountName,
    ownerName: i.ownerName,
    amountCents: i.amountCents,
    dueAt: i.dueAt.toISOString(),
    status: effectiveStatus(i, now),
    storedStatus: i.status,
    daysOverdue: daysOverdue(i.dueAt, now),
    paidAt: i.paidAt?.toISOString() ?? null,
    paidInKind: i.paidInKind,
    notes: i.notes,
  }));

  const dealById = new Map(dealRows.map((d) => [d.id, d]));
  const renewals = renewalsDue(adsDeals, now).map((r) => {
    const d = dealById.get(r.deal.id)!;
    return { id: d.id, name: d.name, accountName: d.accountName, ownerName: d.ownerName, renewalAt: d.renewalAt!.toISOString(), days: r.days, window: r.window, annualizedValueCents: d.annualizedValueCents ?? d.contractValueCents };
  });

  // Deals the user can pick when creating an invoice (ADS deals + any deal that already has invoices).
  const invoiceDeals = [
    ...dealRows.map((d) => ({ id: d.id, name: d.name })),
    ...invRows.filter((i) => !dealById.has(i.dealId)).map((i) => ({ id: i.dealId, name: i.dealName })),
  ]
    .filter((d, idx, arr) => arr.findIndex((x) => x.id === d.id) === idx)
    .sort((a, b) => a.name.localeCompare(b.name));

  const deals: AdsDealRow[] = dealRows.map((d) => ({
    id: d.id,
    name: d.name,
    accountName: d.accountName,
    ownerName: d.ownerName,
    stageKey: d.stageKey,
    stageName: d.stageName,
    contractValueCents: d.contractValueCents,
    annualizedValueCents: d.annualizedValueCents,
    nextPaymentCents: d.nextPaymentCents,
    nextPaymentAt: d.nextPaymentAt?.toISOString() ?? null,
    renewalAt: d.renewalAt?.toISOString() ?? null,
    canEdit: adsEditScope !== "none" && inScope(user, adsEditScope, { ownerId: d.ownerId, teamId: d.teamId, pipelineKey: "ADS" }),
  }));

  return {
    summary: revenueSummary(adsDeals, invForCalc, now),
    aging: arAging(invForCalc, now),
    concentration: concentration(adsDeals),
    renewals,
    invoices,
    deals,
    invoiceDeals,
    perms: { canCreate, canEdit, canDelete },
  };
}

/** For integrations (alerts NS-23/24): overdue invoice ids visible to the user. */
export async function overdueInvoiceIds(user: AppUser): Promise<string[]> {
  const where = await revenueDealWhere(user, "view");
  const rows = await db
    .select({ id: s.invoices.id, status: s.invoices.status, dueAt: s.invoices.dueAt })
    .from(s.invoices)
    .innerJoin(s.deals, eq(s.deals.id, s.invoices.dealId))
    .where(and(where, inArray(s.invoices.status, ["scheduled", "sent", "overdue"])));
  const now = new Date();
  return rows.filter((r) => effectiveStatus(r, now) === "overdue").map((r) => r.id);
}
