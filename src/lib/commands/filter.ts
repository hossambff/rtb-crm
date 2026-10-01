import "server-only";
import { and, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import * as s from "@/db/schema";
import { getStagesByPipeline, listActiveUsers, listVisiblePipelines } from "@/lib/deals/queries";
import type { AppUser } from "@/lib/rbac/server";
import type { Vocab } from "./parse";
import type { DealFilter } from "./types";

/**
 * DealFilter → SQL (requires deals ⋈ pipelines ⋈ stages, accounts left-joined). Shared by the ⌘K preview and the
 * /deals list so "Select all N matching" and a typed command select exactly the same records. Access control is NOT
 * here — callers always AND it with dealAccessWhere(user, …).
 */
export function dealFilterConds(user: AppUser, f: DealFilter, now = new Date()): SQL[] {
  const c: SQL[] = [eq(s.pipelines.active, true)];
  const status = f.status ?? "open";
  if (status !== "any") c.push(eq(s.deals.status, status));
  if (f.ids) c.push(f.ids.length ? inArray(s.deals.id, f.ids) : sql`false`);
  if (f.pipelineKeys?.length) c.push(inArray(s.pipelines.key, f.pipelineKeys));
  if (f.stageNames?.length) c.push(inArray(sql`lower(${s.stages.name})`, f.stageNames.map((n) => n.toLowerCase())));
  if (f.owner === "me") c.push(eq(s.deals.ownerId, user.id));
  else if (f.owner === "none") c.push(isNull(s.deals.ownerId));
  else if (f.owner) c.push(eq(s.deals.ownerId, f.owner));
  if (f.ownerIds?.length) c.push(inArray(s.deals.ownerId, f.ownerIds));
  if (f.team) c.push(inArray(s.deals.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]));
  if (f.idleDays) {
    const cutoff = new Date(now.getTime() - f.idleDays * 86_400_000).toISOString();
    c.push(sql`coalesce(${s.deals.lastActivityAt}, ${s.deals.createdAt}) < ${cutoff}::timestamptz`);
  }
  if (f.overdue) c.push(and(eq(s.deals.status, "open"), lt(s.deals.nextStepDueAt, now))!);
  if (f.noNextStep) c.push(and(sql`coalesce(trim(${s.deals.nextStep}), '') = ''`, isNull(s.deals.nextStepWaitingReason))!);
  if (f.noCloseDate) c.push(isNull(s.deals.expectedCloseDate));
  if (f.healthBelow) c.push(lt(s.deals.healthScore, f.healthBelow));
  if (f.priority) c.push(eq(s.deals.priority, f.priority));
  if (f.tag) c.push(sql`${s.deals.tags} @> array[${f.tag.toLowerCase()}]::text[]`);
  if (f.text) {
    const pat = `%${f.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(or(ilike(s.deals.name, pat), ilike(s.accounts.name, pat), ilike(s.accounts.domain, pat))!);
  }
  return c;
}

/** Names the parser/AI may resolve against: visible pipelines, their stages, active users. Internal data only. */
export async function loadVocab(user: AppUser, selection?: string[]): Promise<Vocab> {
  const pipes = await listVisiblePipelines(user);
  const stagesBy = await getStagesByPipeline();
  const users = await listActiveUsers();
  return {
    meId: user.id,
    pipelines: pipes.map((p) => ({ key: p.key, name: p.name })),
    stages: pipes.flatMap((p) => (stagesBy[p.id] ?? []).map((st) => ({ pipelineKey: p.key, key: st.key, name: st.name, category: st.category }))),
    users: users.map((u) => ({ id: u.id, name: u.name })),
    selection,
  };
}
