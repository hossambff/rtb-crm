/** Revenue (TheStreet ADS) math — PRD ADS-1..4. Pure, unit tested. Money in cents. */

export type InvoiceStatus = "scheduled" | "sent" | "paid" | "overdue" | "written_off";
export const INVOICE_STATUSES: InvoiceStatus[] = ["scheduled", "sent", "overdue", "paid", "written_off"];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  scheduled: "Scheduled",
  sent: "Sent",
  overdue: "Overdue",
  paid: "Paid",
  written_off: "Written off",
};

const DAY = 86_400_000;

/** Effective status: an unpaid invoice past its due date is overdue whatever its stored status. */
export function effectiveStatus(inv: { status: string; dueAt: Date }, now: Date): InvoiceStatus {
  if (inv.status === "paid" || inv.status === "written_off") return inv.status;
  if (inv.dueAt.getTime() < startOfDay(now).getTime()) return "overdue";
  return inv.status === "overdue" ? "sent" : (inv.status as InvoiceStatus);
}

export function daysOverdue(dueAt: Date, now: Date): number {
  return Math.max(0, Math.floor((startOfDay(now).getTime() - startOfDay(dueAt).getTime()) / DAY));
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(days: number): AgingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** AR aging of open overdue receivables by days past due. */
export function arAging(invoices: { status: string; dueAt: Date; amountCents: number }[], now: Date) {
  const out: Record<AgingBucket, { count: number; cents: number }> = {
    "0-30": { count: 0, cents: 0 },
    "31-60": { count: 0, cents: 0 },
    "61-90": { count: 0, cents: 0 },
    "90+": { count: 0, cents: 0 },
  };
  for (const inv of invoices) {
    if (effectiveStatus(inv, now) !== "overdue") continue;
    const b = agingBucket(daysOverdue(inv.dueAt, now));
    out[b].count++;
    out[b].cents += inv.amountCents;
  }
  return AGING_BUCKETS.map((bucket) => ({ bucket, ...out[bucket] }));
}

/** ADS stage keys → exec-summary category (ADS-1). */
export const ADS_CATEGORY: Record<string, "warm" | "active" | "current" | "renewal" | "churned"> = {
  warm: "warm",
  negotiation: "warm",
  verbal: "active",
  loi: "active",
  won: "active",
  current_client: "current",
  renewal: "renewal",
  churned: "churned",
};

export type AdsDeal = {
  id: string;
  stageKey: string;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
  renewalAt: Date | null;
  accountId: string | null;
  accountName: string | null;
};

const dealCents = (d: AdsDeal) => d.contractValueCents ?? d.annualizedValueCents ?? 0;
const annualCents = (d: AdsDeal) => d.annualizedValueCents ?? d.contractValueCents ?? 0;

/** C&W exec summary widgets (ADS-3). */
export function revenueSummary(deals: AdsDeal[], invoices: { status: string; dueAt: Date; amountCents: number }[], now: Date) {
  const active = deals.filter((d) => ADS_CATEGORY[d.stageKey] === "active");
  const current = deals.filter((d) => ADS_CATEGORY[d.stageKey] === "current" || ADS_CATEGORY[d.stageKey] === "renewal");
  const warm = deals.filter((d) => ADS_CATEGORY[d.stageKey] === "warm");
  const horizon = now.getTime() + 60 * DAY;
  let upcomingCount = 0;
  let upcomingCents = 0;
  let overdueCount = 0;
  let overdueCents = 0;
  for (const inv of invoices) {
    const st = effectiveStatus(inv, now);
    if (st === "overdue") {
      overdueCount++;
      overdueCents += inv.amountCents;
    } else if ((st === "scheduled" || st === "sent") && inv.dueAt.getTime() <= horizon) {
      upcomingCount++;
      upcomingCents += inv.amountCents;
    }
  }
  return {
    activeClosing: { count: active.length, cents: active.reduce((a, d) => a + dealCents(d), 0) },
    currentAnnualized: { count: current.length, cents: current.reduce((a, d) => a + annualCents(d), 0) },
    upcomingCollections: { count: upcomingCount, cents: upcomingCents },
    overdue: { count: overdueCount, cents: overdueCents },
    warmNegotiation: { count: warm.length, cents: warm.reduce((a, d) => a + dealCents(d), 0) },
  };
}

/** Renewals due within 60/30/14 days (ADS-4). Returns the tightest window each deal falls into. */
export function renewalsDue(deals: AdsDeal[], now: Date) {
  const out: { deal: AdsDeal; days: number; window: 14 | 30 | 60 }[] = [];
  for (const d of deals) {
    if (!d.renewalAt || ADS_CATEGORY[d.stageKey] === "churned") continue;
    const days = Math.ceil((d.renewalAt.getTime() - now.getTime()) / DAY);
    if (days < 0 || days > 60) continue;
    out.push({ deal: d, days, window: days <= 14 ? 14 : days <= 30 ? 30 : 60 });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Customer concentration: share of current-client annualized revenue by account, top N + other. */
export function concentration(deals: AdsDeal[], topN = 6) {
  const byAccount = new Map<string, { name: string; cents: number }>();
  for (const d of deals) {
    const cat = ADS_CATEGORY[d.stageKey];
    if (cat !== "current" && cat !== "renewal" && cat !== "active") continue;
    const key = d.accountId ?? d.id;
    const cur = byAccount.get(key) ?? { name: d.accountName ?? "Unassigned", cents: 0 };
    cur.cents += annualCents(d);
    byAccount.set(key, cur);
  }
  const rows = [...byAccount.values()].filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const total = rows.reduce((a, r) => a + r.cents, 0);
  const top = rows.slice(0, topN);
  const rest = rows.slice(topN).reduce((a, r) => a + r.cents, 0);
  const list = [...top, ...(rest > 0 ? [{ name: "Other", cents: rest }] : [])];
  return { total, rows: list.map((r) => ({ ...r, share: total > 0 ? r.cents / total : 0 })), topShare: total > 0 && top[0] ? top[0].cents / total : 0 };
}
