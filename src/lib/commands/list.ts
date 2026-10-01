import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { grossUsd as grossSql, prob } from "@/lib/analytics/value-sql";
import { dealValue } from "@/lib/pipeline-math";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { dealFilterConds } from "./filter";
import type { DealFilter } from "./types";

/** /deals — one list across every motion the user can see, same filter object as ⌘K commands (V2 A8, KAN-5). */

export const DEALS_PAGE_SIZE = 50;
export const DEAL_SORTS = ["weighted", "name", "stage", "owner", "due", "idle", "health", "close"] as const;
export type DealSort = (typeof DEAL_SORTS)[number];

export type DealRow = {
  id: string;
  name: string;
  accountName: string | null;
  pipelineKey: string;
  pipelineColor: string;
  unit: "muu" | "usd" | "activation";
  stageName: string;
  stageCategory: string;
  ownerId: string | null;
  ownerName: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  overdue: boolean;
  idleDays: number;
  healthScore: number | null;
  priority: string | null;
  muu: number;
  grossUsd: number;
  weightedUsd: number;
  expectedCloseDate: string | null;
  tags: string[];
  restricted: boolean;
  canEdit: boolean;
};

export type DealPage = { rows: DealRow[]; total: number; page: number; pageSize: number; weightedUsd: number; grossUsd: number };

export async function listDealsAcross(user: AppUser, f: DealFilter, opts: { page?: number; sort?: DealSort; dir?: "asc" | "desc" } = {}): Promise<DealPage> {
  const view = await dealAccessWhere(user, "view");
  const edit = await dealAccessWhere(user, "edit");
  const where = and(view, ...dealFilterConds(user, f))!;
  const owner = alias(s.user, "dl_owner");
  const w = sql<number>`${grossSql} * ${prob(true)}`;
  const idle = sql`coalesce(${s.deals.lastActivityAt}, ${s.deals.createdAt})`;
  const sortExpr: Record<DealSort, SQL> = {
    weighted: w,
    name: sql`lower(${s.deals.name})`,
    stage: sql`${s.pipelines.sortOrder} * 1000 + ${s.stages.sortOrder}`,
    owner: sql`lower(coalesce(${owner.name}, ''))`,
    due: sql`${s.deals.nextStepDueAt}`,
    idle: idle, // asc = idle longest first is "desc" days; handled below
    health: sql`coalesce(${s.deals.healthScore}, -1)`,
    close: sql`${s.deals.expectedCloseDate}`,
  };
  const sort: DealSort = opts.sort && (DEAL_SORTS as readonly string[]).includes(opts.sort) ? opts.sort : "weighted";
  const dir = opts.dir === "asc" ? "asc" : "desc";
  const flip = sort === "idle"; // "idle desc" = most idle first = oldest last-activity first
  const order = (dir === "asc") !== flip ? sql`${sortExpr[sort]} asc nulls last` : sql`${sortExpr[sort]} desc nulls last`;

  const [agg] = await db
    .select({ total: sql<number>`count(*)::int`, weighted: sql<number>`coalesce(sum(${w}), 0)::float8`, gross: sql<number>`coalesce(sum(${grossSql}), 0)::float8` })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(where);
  const total = agg?.total ?? 0;
  const last = Math.max(1, Math.ceil(total / DEALS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), last);
  const rows = total
    ? await db
        .select({ deal: s.deals, pipeline: s.pipelines, stage: s.stages, accountName: s.accounts.name, ownerName: owner.name, canEdit: sql<boolean>`(${edit})` })
        .from(s.deals)
        .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
        .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .leftJoin(owner, eq(owner.id, s.deals.ownerId))
        .where(where)
        .orderBy(order, asc(s.deals.id))
        .limit(DEALS_PAGE_SIZE)
        .offset((page - 1) * DEALS_PAGE_SIZE)
    : [];
  const now = Date.now();
  return {
    total,
    page,
    pageSize: DEALS_PAGE_SIZE,
    weightedUsd: agg?.weighted ?? 0,
    grossUsd: agg?.gross ?? 0,
    rows: rows.map((r) => {
      const v = dealValue({
        unit: r.pipeline.unit,
        muu: r.deal.muu,
        usdPerMuu: r.deal.usdPerMuu,
        pipelineUsdPerMuu: r.pipeline.usdPerMuu,
        revSharePct: r.deal.revSharePct,
        pipelineRevSharePct: r.pipeline.defaultRevSharePct,
        contractValueCents: r.deal.contractValueCents,
        annualizedValueCents: r.deal.annualizedValueCents,
        stageProbability: r.stage.probability,
        probabilityOverride: r.deal.probabilityOverride,
        overrideStatus: r.deal.overrideStatus,
      });
      const lastTouch = (r.deal.lastActivityAt ?? r.deal.createdAt).getTime();
      return {
        id: r.deal.id,
        name: r.deal.name,
        accountName: r.accountName,
        pipelineKey: r.pipeline.key,
        pipelineColor: r.pipeline.color,
        unit: r.pipeline.unit,
        stageName: r.stage.name,
        stageCategory: r.stage.category,
        ownerId: r.deal.ownerId,
        ownerName: r.ownerName,
        nextStep: r.deal.nextStep,
        nextStepDueAt: r.deal.nextStepDueAt?.toISOString() ?? null,
        overdue: r.stage.category === "open" && r.deal.nextStepDueAt != null && r.deal.nextStepDueAt.getTime() < now,
        idleDays: Math.max(0, Math.floor((now - lastTouch) / 86_400_000)),
        healthScore: r.deal.healthScore,
        priority: r.deal.priority,
        muu: v.muu,
        grossUsd: v.grossUsd,
        weightedUsd: v.weightedGrossUsd,
        expectedCloseDate: r.deal.expectedCloseDate?.toISOString() ?? null,
        tags: r.deal.tags,
        restricted: r.deal.restricted,
        canEdit: Boolean(r.canEdit),
      };
    }),
  };
}

/** /deals URL params → DealFilter (same keys as filterToParams). */
export function paramsToFilter(sp: Record<string, string | string[] | undefined>, user: AppUser): DealFilter {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const f: DealFilter = {};
  const motion = one("motion");
  if (motion) f.pipelineKeys = motion.toUpperCase().split(",").filter(Boolean).slice(0, 10).map((k) => k.slice(0, 20));
  const stage = one("stage");
  if (stage) f.stageNames = stage.split(",").filter(Boolean).slice(0, 10).map((x) => x.slice(0, 80));
  const owner = one("owner");
  if (owner === "team") f.team = true;
  else if (owner === "all") void 0;
  else if (owner) f.owner = owner === user.id ? "me" : owner.slice(0, 100);
  const idle = Number(one("idle"));
  if (Number.isInteger(idle) && idle > 0 && idle <= 3650) f.idleDays = idle;
  if (one("overdue") === "1") f.overdue = true;
  if (one("nonext") === "1") f.noNextStep = true;
  if (one("noclose") === "1") f.noCloseDate = true;
  const health = Number(one("health"));
  if (Number.isInteger(health) && health > 0 && health <= 100) f.healthBelow = health;
  const pr = one("priority");
  if (pr && ["top10", "high", "medium", "low"].includes(pr)) f.priority = pr as DealFilter["priority"];
  const tag = one("tag");
  if (tag) f.tag = tag.toLowerCase().slice(0, 60);
  const q = one("q");
  if (q) f.text = q.slice(0, 120);
  const st = one("status");
  if (st && ["open", "won", "lost", "hold", "any"].includes(st)) f.status = st as DealFilter["status"];
  return f;
}
