import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { assertCan, dealAccessWhere, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { getSetting } from "@/lib/settings";
import { burnUp, interviewSummary, isLive, parseInterviews, participationNow, type Interview, type R100Json } from "./calc";

export type R100Row = {
  id: string;
  name: string;
  accountId: string | null;
  company: string;
  ticker: string | null;
  tokenName: string | null;
  category: string | null;
  ownerId: string | null;
  ownerName: string | null;
  stageId: string;
  stageKey: string;
  stageName: string;
  live: boolean;
  r100: R100Json;
  interviews: Interview[];
  interviewStatus: string | null;
  participationNow: ReturnType<typeof participationNow>;
  canEdit: boolean;
};

export async function getR100Program(user: AppUser) {
  await assertCan(user, "deals_R100", "view");
  const [pipeline] = await db.select().from(s.pipelines).where(eq(s.pipelines.key, "R100"));
  if (!pipeline) return null;
  const now = new Date();
  const [stages, access, editScope, goal] = await Promise.all([
    db.select().from(s.stages).where(eq(s.stages.pipelineId, pipeline.id)).orderBy(asc(s.stages.sortOrder)),
    dealAccessWhere(user, "view"),
    scopeFor(user, "deals_R100", "edit"),
    getSetting<number>("r100.goal_live", 100),
  ]);
  const rows = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      stageId: s.deals.stageId,
      ownerId: s.deals.ownerId,
      teamId: s.deals.teamId,
      wonAt: s.deals.wonAt,
      r100: s.deals.r100,
      customFields: s.deals.customFields,
      accountId: s.deals.accountId,
      accountName: s.accounts.name,
      ticker: s.accounts.ticker,
      tokenName: s.accounts.tokenName,
      category: s.accounts.category,
      ownerName: s.user.name,
    })
    .from(s.deals)
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
    .where(and(access, eq(s.deals.pipelineId, pipeline.id)))
    .limit(5000);

  const ids = rows.map((r) => r.id);
  const splits = ids.length ? await db.select().from(s.dealSplits).where(inArray(s.dealSplits.dealId, ids)) : [];
  const splitMap = new Map<string, string[]>();
  for (const sp of splits) splitMap.set(sp.dealId, [...(splitMap.get(sp.dealId) ?? []), sp.userId]);
  const stageById = new Map(stages.map((st) => [st.id, st]));

  const out: R100Row[] = rows.map((r) => {
    const st = stageById.get(r.stageId);
    const r100 = (r.r100 ?? {}) as R100Json;
    const interviews = parseInterviews(r.customFields);
    return {
      id: r.id,
      name: r.name,
      accountId: r.accountId,
      company: r.accountName ?? r.name,
      ticker: r.ticker,
      tokenName: r.tokenName,
      category: r.category,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      stageId: r.stageId,
      stageKey: st?.key ?? "",
      stageName: st?.name ?? "—",
      live: st ? isLive(st) : false,
      r100,
      interviews,
      interviewStatus: interviewSummary(interviews),
      participationNow: participationNow(r100, now),
      canEdit: editScope !== "none" && inScope(user, editScope, { ownerId: r.ownerId, teamId: r.teamId, splitUserIds: splitMap.get(r.id), pipelineKey: "R100" }),
    };
  });

  // Live first, then furthest-along stages, then name.
  const order = (id: string) => stageById.get(id)?.sortOrder ?? 0;
  out.sort((a, b) => Number(b.live) - Number(a.live) || order(b.stageId) - order(a.stageId) || a.company.localeCompare(b.company));

  const live = out.filter((r) => r.live);
  const liveRaw = rows.filter((r) => {
    const st = stageById.get(r.stageId);
    return st ? isLive(st) : false;
  });
  const funnel = stages
    .filter((st) => st.category !== "lost")
    .map((st) => ({ key: st.key, name: st.name, count: out.filter((r) => r.stageId === st.id).length, live: isLive(st) }));
  const participating = live.filter((r) => r.participationNow === "posted").length;
  const inWindow = live.filter((r) => r.participationNow === "posted" || r.participationNow === "missing").length;

  return {
    goal: Number(goal) || 100,
    liveCount: live.length,
    total: out.length,
    rows: out,
    stages: stages.map((st) => ({ id: st.id, key: st.key, name: st.name, category: st.category })),
    funnel,
    burnUp: burnUp(
      liveRaw.map((r) => ({ firstPostDate: (r.r100 as R100Json)?.firstPostDate, wonAt: r.wonAt })),
      now,
    ),
    participation: { participating, inWindow },
    canEditAny: editScope !== "none",
  };
}
