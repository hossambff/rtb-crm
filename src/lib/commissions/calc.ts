/**
 * Commission math (PRD COM-1..4). Pure — no server deps; unit tested.
 * The DB runner in engine.ts collects qualifying events, then `planAccruals` decides what to write.
 *
 * Conventions: money in cents; rule.rate is a percent 0..100 for pct_* rate types and cents for `flat`.
 * Caps (`capCents`) are cumulative per user × plan × rule × calendar month (period).
 * Periods are UTC calendar months (`periodOf`) — an accepted simplification, documented in docs/audits/CODE_REVIEW.md
 * (a deal won 22:00 ET on the last day of a month books to the next month).
 *
 * Idempotency (CR-01): every accrual carries `source_key` = `<trigger>:<ruleId>:<eventId>:<userId>`, backed by the unique
 * index (user_id, plan_id, source_key) and written with ON CONFLICT DO NOTHING. `ruleId` is the rule's stable `id`
 * (kept across plan edits) or, for rules saved before ids existed, a hash of the rule's content — never its position in
 * the rules array, so deleting or reordering a rule can't re-accrue past events.
 */

export const TRIGGERS = ["deal_won", "invoice_paid", "r100_live", "meeting_held", "migration_launched"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const TRIGGER_LABELS: Record<Trigger, string> = {
  deal_won: "Deal won",
  invoice_paid: "Invoice paid (cash basis)",
  r100_live: "RTB100 live",
  meeting_held: "Meeting held",
  migration_launched: "Migration launched",
};

export const RATE_TYPES = ["pct_contract", "pct_net", "flat"] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const RATE_TYPE_LABELS: Record<RateType, string> = {
  pct_contract: "% of contract / collected value",
  pct_net: "% of RTB net revenue",
  flat: "Flat bounty",
};

export type PlanRule = {
  /** Stable identity (uuid assigned by savePlan, or `h…` content hash for legacy rules). Never the array index. */
  id?: string;
  trigger: Trigger;
  pipelineKeys?: string[];
  rateType: RateType;
  rate: number;
  capCents?: number;
  clawbackDays?: number;
};

export const ACCRUAL_STATUSES = ["accrued", "approved", "paid", "disputed", "clawed_back"] as const;
export type AccrualStatus = (typeof ACCRUAL_STATUSES)[number];

/** A normalized qualifying event (built by the DB runner). */
export type CommissionEvent = {
  trigger: Trigger;
  /** Unique id of the source record (deal id, invoice id, activity id, project id). */
  sourceId: string;
  at: Date;
  pipelineKey: string | null;
  dealId: string | null;
  invoiceId?: string | null;
  /** Base for pct_contract (contract value, or the paid invoice amount), cents. */
  contractCents: number;
  /** Base for pct_net (RTB net revenue), cents. */
  netCents: number;
  /** Who is credited and how much (0..100). Deal splits, else owner 100%. */
  recipients: { userId: string; pct: number }[];
  label: string;
};

export type AccrualDraft = {
  key: string;
  userId: string;
  planId: string;
  dealId: string | null;
  invoiceId: string | null;
  trigger: string;
  amountCents: number;
  status: AccrualStatus;
  period: string;
  note: string;
  /** When the commission event happened (clawback windows are measured from it). */
  eventAt?: Date;
};

export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** FNV-1a 32-bit, base36 — deterministic, dependency-free (runs on the client plan editor too). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Content identity of a rule (what it pays for and how) — used only for rules that have no stored `id`. */
export function ruleContentId(r: Omit<PlanRule, "id">): string {
  const canon = [r.trigger, [...(r.pipelineKeys ?? [])].sort().join(","), r.rateType, r.rate, r.capCents ?? "", r.clawbackDays ?? ""].join("|");
  return `h${fnv1a(canon)}`;
}

const cleanId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

/** Give every rule a stable id: its stored `id`, else its content hash (duplicates of identical content get `-2`, `-3`…). */
export function withRuleIds<T extends PlanRule>(rules: T[]): (T & { id: string })[] {
  const seen = new Map<string, number>();
  return rules.map((r) => {
    let id = typeof r.id === "string" && cleanId(r.id) ? cleanId(r.id) : ruleContentId(r);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    return { ...r, id };
  });
}

/** Idempotency key for one accrual (stored in commission_accruals.source_key). */
export function accrualKey(ruleId: string, trigger: string, sourceId: string, userId: string): string {
  return `${trigger}:${ruleId}:${sourceId}:${userId}`;
}
/** The rule id inside an accrual key (or a clawback key). */
export function ruleIdFromKey(key: string): string | null {
  const k = key.startsWith(CLAWBACK_PREFIX) ? key.slice(CLAWBACK_PREFIX.length) : key;
  const parts = k.split(":");
  return parts.length >= 4 ? parts[1]! : null;
}
/** Legacy note prefix (`[k:<key>] …`) — accruals written before source_key existed; kept for display only. */
export function keyNote(key: string, text: string): string {
  return `[k:${key}] ${text}`.trim();
}
export function keyFromNote(note: string | null | undefined): string | null {
  const m = note?.match(/^\[k:([^\]]+)\]/);
  return m ? m[1]! : null;
}

/** Normalize untrusted rules JSON from the DB. */
export function normalizeRules(raw: unknown): (PlanRule & { id: string })[] {
  if (!Array.isArray(raw)) return [];
  const rules: PlanRule[] = raw
    .filter((r) => r && typeof r === "object" && (TRIGGERS as readonly string[]).includes(r.trigger))
    .map((r) => ({
      id: typeof r.id === "string" ? r.id : undefined,
      trigger: r.trigger as Trigger,
      pipelineKeys: Array.isArray(r.pipelineKeys) ? r.pipelineKeys.map(String).filter(Boolean) : undefined,
      rateType: (RATE_TYPES as readonly string[]).includes(r.rateType) ? (r.rateType as RateType) : "flat",
      rate: Number.isFinite(Number(r.rate)) ? Math.max(0, Number(r.rate)) : 0,
      capCents: r.capCents != null && Number.isFinite(Number(r.capCents)) ? Math.max(0, Math.round(Number(r.capCents))) : undefined,
      clawbackDays: r.clawbackDays != null && Number.isFinite(Number(r.clawbackDays)) ? Math.max(0, Math.round(Number(r.clawbackDays))) : undefined,
    }));
  return withRuleIds(rules);
}

/** Gross commission for one event before splits/caps. */
export function ruleAmountCents(rule: PlanRule, ev: Pick<CommissionEvent, "contractCents" | "netCents">): number {
  switch (rule.rateType) {
    case "flat":
      return Math.round(rule.rate);
    case "pct_contract":
      return Math.round((Math.max(0, ev.contractCents) * rule.rate) / 100);
    case "pct_net":
      return Math.round((Math.max(0, ev.netCents) * rule.rate) / 100);
  }
}

/** Remaining headroom under a cumulative cap. */
export function applyCap(amountCents: number, alreadyCents: number, capCents: number | undefined): number {
  if (capCents == null || capCents <= 0) return amountCents;
  return Math.max(0, Math.min(amountCents, capCents - alreadyCents));
}

/** Splits for a deal: explicit splits (0..100) normalized to at most 100%, else the owner at 100%. */
export function recipientsFor(ownerId: string | null, splits: { userId: string; pct: number }[]): { userId: string; pct: number }[] {
  const valid = splits.filter((s) => s.pct > 0);
  if (valid.length) {
    const total = valid.reduce((a, s) => a + s.pct, 0);
    const scale = total > 100 ? 100 / total : 1;
    return valid.map((s) => ({ userId: s.userId, pct: s.pct * scale }));
  }
  return ownerId ? [{ userId: ownerId, pct: 100 }] : [];
}

export function ruleMatches(rule: PlanRule, ev: CommissionEvent): boolean {
  if (rule.trigger !== ev.trigger) return false;
  if (rule.pipelineKeys?.length) return ev.pipelineKey != null && rule.pipelineKeys.includes(ev.pipelineKey);
  return true;
}

/**
 * Decide the accruals to write for one assignment (user × plan). Pure and idempotent:
 * - only events at/after effectiveFrom where the user is a recipient;
 * - skips keys already in `existingKeys` (source keys, see `accrualKey`);
 * - applies caps using `periodTotals` (key `${ruleId}|${period}` → cents already accrued), updated as it goes.
 */
export function planAccruals(input: {
  userId: string;
  planId: string;
  planName: string;
  effectiveFrom: Date;
  rules: PlanRule[];
  events: CommissionEvent[];
  existingKeys: Set<string>;
  periodTotals: Map<string, number>;
}): AccrualDraft[] {
  const drafts: AccrualDraft[] = [];
  const sorted = [...input.events].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const rule of withRuleIds(input.rules)) {
    for (const ev of sorted) {
      if (!ruleMatches(rule, ev)) continue;
      if (ev.at.getTime() < input.effectiveFrom.getTime()) continue;
      const share = ev.recipients.find((r) => r.userId === input.userId);
      if (!share) continue;
      const key = accrualKey(rule.id, ev.trigger, ev.sourceId, input.userId);
      if (input.existingKeys.has(key)) continue;
      const period = periodOf(ev.at);
      const gross = ruleAmountCents(rule, ev);
      const split = Math.round((gross * share.pct) / 100);
      const capKey = capKeyOf(rule.id, period);
      const already = input.periodTotals.get(capKey) ?? 0;
      const amount = applyCap(split, already, rule.capCents);
      if (amount <= 0) continue;
      input.periodTotals.set(capKey, already + amount);
      input.existingKeys.add(key);
      const pctNote = share.pct < 100 ? ` · ${Math.round(share.pct * 100) / 100}% split` : "";
      const capNote = amount < split ? " · capped" : "";
      drafts.push({
        key,
        userId: input.userId,
        planId: input.planId,
        dealId: ev.dealId,
        invoiceId: ev.invoiceId ?? null,
        trigger: ev.trigger,
        amountCents: amount,
        status: "accrued",
        period,
        eventAt: ev.at,
        note: `${input.planName}: ${ev.label}${pctNote}${capNote}`,
      });
    }
  }
  return drafts;
}

export const capKeyOf = (ruleId: string, period: string) => `${ruleId}|${period}`;

/** Clawback applies when the deal was lost within `clawbackDays` of the commission event. */
export function clawbackDue(p: { eventAt: Date | null; lostAt: Date | null; clawbackDays: number | undefined }): boolean {
  if (!p.clawbackDays || !p.eventAt || !p.lostAt) return false;
  const days = (p.lostAt.getTime() - p.eventAt.getTime()) / 86_400_000;
  return days >= 0 && days <= p.clawbackDays;
}

/**
 * When the commission event behind an accrual happened, for the clawback window (H-02). A lost deal no longer has
 * `won_at` (stage-service clears it on leaving a won stage), so `deal_won` uses the last entry into a won stage from
 * deal_stage_history (`lastWinAt`). Fallback when there is no such history (e.g. deals imported as won): the accrual's
 * creation time, which is never earlier than the event — the window can only shrink, so no false clawbacks.
 */
export function clawbackEventAt(p: {
  trigger: string;
  paidAt?: Date | null;
  firstPostDate?: string | null;
  goLiveAt?: Date | null;
  lastWinAt?: Date | null;
  accruedAt: Date;
}): Date {
  const valid = (d: Date | null | undefined) => (d && !Number.isNaN(d.getTime()) ? d : null);
  const win = valid(p.lastWinAt) ?? p.accruedAt;
  switch (p.trigger) {
    case "invoice_paid":
      return valid(p.paidAt) ?? p.accruedAt;
    case "r100_live":
      return valid(p.firstPostDate ? new Date(p.firstPostDate) : null) ?? win;
    case "migration_launched":
      return valid(p.goLiveAt) ?? win;
    default:
      return win;
  }
}

const CLAWBACK_PREFIX = "clawback:";
export function clawbackKey(originalKey: string): string {
  return `${CLAWBACK_PREFIX}${originalKey}`;
}
export const isClawbackKey = (key: string) => key.startsWith(CLAWBACK_PREFIX);

/** Statement totals for a list of accrual rows. */
export function statementTotals(rows: { amountCents: number; status: string }[]) {
  const t = { gross: 0, clawbacks: 0, net: 0, accrued: 0, approved: 0, paid: 0, disputed: 0 };
  for (const r of rows) {
    if (r.amountCents >= 0) t.gross += r.amountCents;
    else t.clawbacks += r.amountCents;
    t.net += r.amountCents;
    if (r.status === "accrued") t.accrued += r.amountCents;
    if (r.status === "approved") t.approved += r.amountCents;
    if (r.status === "paid") t.paid += r.amountCents;
    if (r.status === "disputed") t.disputed += r.amountCents;
  }
  return t;
}

/** COM-7 what-if: estimated earnings for a hypothetical close. */
export function whatIf(rules: PlanRule[], p: { pipelineKey: string; contractCents: number; netCents: number; splitPct: number }): number {
  let total = 0;
  for (const rule of rules) {
    if (rule.trigger !== "deal_won" && rule.trigger !== "invoice_paid") continue;
    if (rule.pipelineKeys?.length && !rule.pipelineKeys.includes(p.pipelineKey)) continue;
    const gross = ruleAmountCents(rule, { contractCents: p.contractCents, netCents: p.netCents });
    total += applyCap(Math.round((gross * p.splitPct) / 100), 0, rule.capCents);
  }
  return total;
}
