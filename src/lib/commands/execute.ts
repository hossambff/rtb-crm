import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, withXactLock } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { dealAccessWhere, getHiddenFields, type AppUser } from "@/lib/rbac/server";
import { bulkMoveStage, bulkReassign } from "@/lib/deals/actions";
import { recomputeDealHealth } from "@/lib/deals/service";
import { enrollInSequence, stopEnrollments } from "@/lib/sequences/actions";
import { dealNames, type RunPayload } from "./service";
import { signToken, verifyToken } from "./token";
import { dateOnlyToInstant, safeTz } from "@/lib/time";
import { MAX_COMMAND_RECORDS, type ExecuteResult } from "./types";
import { chunks, commandFieldHidden, EXECUTE_BUDGET_MS, partitionForUndo } from "./undo-core";

/**
 * What an undo may revert. `expect` = the value the command left (CR M2: undo is compare-and-set — a record changed
 * since then is skipped and reported, never overwritten).
 */
type UndoPayload =
  | { v: "move"; groups: { toStageId: string; expect?: string; ids: string[] }[]; label: string }
  | { v: "assign"; groups: { ownerId: string; expect?: string; ids: string[] }[]; label: string }
  | { v: "tag"; tag: string; ids: string[]; label: string }
  | { v: "close"; groups: { date: string | null; expect?: string; ids: string[] }[]; label: string }
  | { v: "enroll"; enrollmentIds: string[]; label: string };

type RunCtx = { deadline: number };

const plural = (n: number, w = "deal") => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Run a previewed command. The token (signed at preview time) fixes the verb, the target and the maximum set of
 * records; `ids` may only narrow it (the user can untick rows). Every write goes through the existing bulk actions,
 * which re-check permissions, gates, approvals and audit per record.
 */
export async function runCommand(user: AppUser, input: { token: string; ids: string[]; reasonCode?: string; reasonText?: string }): Promise<ExecuteResult> {
  const p = verifyToken<RunPayload>(input.token, user.id, "run");
  const allowed = new Set(p.ids);
  const ids = Array.from(new Set(input.ids)).filter((id) => allowed.has(id)).slice(0, MAX_COMMAND_RECORDS);
  if (!ids.length) throw new UserError("Nothing selected to change.");

  // SEC L-5 / CR M3: field-level security — a role that can't see a field can't bulk-write it either.
  const hiddenField = commandFieldHidden(p.v, await getHiddenFields(user.role, "deal"));
  if (hiddenField) throw new UserError(`Your role can't edit ${hiddenField === "tags" ? "tags" : "the expected close date"}.`);

  // CR M4: the audit row is written BEFORE the loop (so a timeout still leaves a trace), the result row after.
  await audit({ actorId: user.id, action: "command.execute_start", entity: "command", after: { verb: p.v, text: p.text.slice(0, 500), engine: p.engine, requested: ids.length } });
  const ctx: RunCtx = { deadline: Date.now() + EXECUTE_BUDGET_MS };
  let res: ExecuteResult;
  if (p.v === "move") res = await runMove(user, p, ids, input, ctx);
  else if (p.v === "assign") res = await runAssign(user, p, ids, ctx);
  else if (p.v === "tag") res = await runTag(user, p.tag, ids);
  else if (p.v === "close") res = await runClose(user, p.date, ids, ctx);
  else res = await runEnroll(user, p, ids);

  await audit({
    actorId: user.id,
    action: "command.execute",
    entity: "command",
    after: { verb: p.v, text: p.text.slice(0, 500), engine: p.engine, requested: ids.length, changed: res.changed, skipped: res.skipped.length, remaining: res.remaining?.length ?? 0 },
  });
  return res;
}

/** Ids not reached before the deadline (returned as `remaining`; the client continues with the same token). */
function leftAfter(all: string[], done: Set<string>): string[] {
  return all.filter((id) => !done.has(id));
}

async function runMove(user: AppUser, p: Extract<RunPayload, { v: "move" }>, ids: string[], input: { reasonCode?: string; reasonText?: string }, ctx: RunCtx): Promise<ExecuteResult> {
  if (p.category === "won" && !input.reasonText?.trim()) throw new UserError("Add a short note on why these deals were won.");
  if ((p.category === "lost" || p.category === "hold") && !input.reasonCode && (input.reasonText?.trim().length ?? 0) < 3) throw new UserError(`Pick a ${p.category} reason.`);
  const view = await dealAccessWhere(user, "view");
  const before = await db.select({ id: s.deals.id, pipelineId: s.deals.pipelineId, stageId: s.deals.stageId }).from(s.deals).where(and(view, inArray(s.deals.id, ids)));
  const byPipeline = new Map<string, string[]>();
  for (const b of before) if (p.stageByPipeline[b.pipelineId]) (byPipeline.get(b.pipelineId) ?? byPipeline.set(b.pipelineId, []).get(b.pipelineId)!).push(b.id);
  const moved: string[] = [];
  const skipped: ExecuteResult["skipped"] = [];
  const attempted = new Set<string>(before.filter((b) => !p.stageByPipeline[b.pipelineId]).map((b) => b.id));
  for (const id of ids) if (!before.some((b) => b.id === id)) attempted.add(id);
  outer: for (const [pipelineId, group] of byPipeline) {
    for (const part of chunks(group)) {
      if (Date.now() > ctx.deadline) break outer;
      const r = await bulkMoveStage({ dealIds: part, toStageId: p.stageByPipeline[pipelineId]!, reasonCode: input.reasonCode, reasonText: input.reasonText?.trim() || undefined });
      if (!r.ok) throw new UserError(r.error);
      moved.push(...r.data.moved);
      skipped.push(...r.data.skipped);
      for (const id of part) attempted.add(id);
    }
  }
  const prevStage = new Map(before.map((b) => [b.id, b.stageId]));
  const pipeOf = new Map(before.map((b) => [b.id, b.pipelineId]));
  const groups = new Map<string, { toStageId: string; expect: string; ids: string[] }>();
  for (const id of moved) {
    const back = prevStage.get(id)!;
    const expect = p.stageByPipeline[pipeOf.get(id)!]!;
    const k = `${back}>${expect}`;
    (groups.get(k) ?? groups.set(k, { toStageId: back, expect, ids: [] }).get(k)!).ids.push(id);
  }
  const undoable = moved.length > 0 && (p.category === "open" || p.category === "hold");
  const remaining = leftAfter(ids, attempted);
  return {
    changed: moved.length,
    skipped,
    message: `${plural(moved.length)} moved to ${p.stageName}${remaining.length ? ` · ${remaining.length} still to go` : ""}`,
    undoToken: undoable ? signToken<UndoPayload>(user.id, "undo", { v: "move", groups: [...groups.values()], label: `Moved ${plural(moved.length)} back` }) : null,
    remaining,
  };
}

async function runAssign(user: AppUser, p: Extract<RunPayload, { v: "assign" }>, ids: string[], ctx: RunCtx): Promise<ExecuteResult> {
  const view = await dealAccessWhere(user, "view");
  const before = await db.select({ id: s.deals.id, ownerId: s.deals.ownerId }).from(s.deals).where(and(view, inArray(s.deals.id, ids)));
  const moved: string[] = [];
  const skippedRaw: { id: string; reason: string }[] = [];
  const attempted = new Set<string>();
  for (const part of chunks(ids)) {
    if (Date.now() > ctx.deadline) break;
    const r = await bulkReassign({ dealIds: part, ownerId: p.ownerId });
    if (!r.ok) throw new UserError(r.error);
    moved.push(...r.data.moved);
    skippedRaw.push(...r.data.skipped);
    for (const id of part) attempted.add(id);
  }
  const names = await dealNames(user, skippedRaw.map((x) => x.id));
  const prev = new Map(before.map((b) => [b.id, b.ownerId]));
  const groups = new Map<string, string[]>();
  for (const id of moved) {
    const o = prev.get(id);
    if (o) (groups.get(o) ?? groups.set(o, []).get(o)!).push(id);
  }
  const remaining = leftAfter(ids, attempted);
  return {
    changed: moved.length,
    skipped: skippedRaw.map((x) => ({ id: x.id, name: names.get(x.id) ?? "Deal", reason: x.reason })),
    message: `${plural(moved.length)} assigned to ${p.ownerName}${remaining.length ? ` · ${remaining.length} still to go` : ""}`,
    undoToken: groups.size ? signToken<UndoPayload>(user.id, "undo", { v: "assign", groups: [...groups].map(([ownerId, g]) => ({ ownerId, expect: p.ownerId, ids: g })), label: `Reassigned ${plural(moved.length)} back` }) : null,
    remaining,
  };
}

/** CR M3: a command edit leaves the same trail as a manual edit — one field_change activity per deal (bulk insert). */
async function logFieldChanges(user: AppUser, rows: { id: string; accountId: string | null }[], subject: string, metadata: Record<string, unknown>) {
  if (!rows.length) return;
  await db.insert(s.activities).values(
    rows.map((r) => ({ type: "field_change" as const, source: "manual" as const, subject, actorId: user.id, dealId: r.id, accountId: r.accountId, occurredAt: new Date(), metadata: { ...metadata, via: "command" } })),
  );
}

/** Recompute health for changed deals: inline until the deadline, the rest after the response (never blocks undo). */
async function recomputeHealthBounded(ids: string[], ctx: RunCtx) {
  const rest: string[] = [];
  for (const id of ids) {
    if (Date.now() > ctx.deadline) rest.push(id);
    else await recomputeDealHealth(id).catch((e) => logServerError("command.health", e));
  }
  if (rest.length) {
    try {
      after(async () => {
        for (const id of rest) await recomputeDealHealth(id).catch((e) => logServerError("command.health", e));
      });
    } catch {
      /* outside a request scope (tests/scripts): skip */
    }
  }
}

/** Add a tag (KAN-5). Edit access is checked in SQL for the whole batch; one audit row per deal. */
async function runTag(user: AppUser, tag: string, ids: string[]): Promise<ExecuteResult> {
  const edit = await dealAccessWhere(user, "edit");
  const updated = await db
    .update(s.deals)
    .set({ tags: sql`array_append(${s.deals.tags}, ${tag}::text)` })
    .where(and(edit, inArray(s.deals.id, ids), sql`not (${s.deals.tags} @> array[${tag}]::text[])`))
    .returning({ id: s.deals.id, accountId: s.deals.accountId });
  const done = new Set(updated.map((u) => u.id));
  for (const id of done) await audit({ actorId: user.id, action: "deal.tag_add", entity: "deal", entityId: id, after: { tag, via: "command" } });
  await logFieldChanges(user, updated, `Tag added: ${tag}`, { field: "tags", tag });
  const rest = ids.filter((id) => !done.has(id));
  const names = await dealNames(user, rest);
  return {
    changed: done.size,
    skipped: rest.map((id) => ({ id, name: names.get(id) ?? "Deal", reason: "Already tagged or not editable" })),
    message: `Tagged ${plural(done.size)} “${tag}”`,
    undoToken: done.size ? signToken<UndoPayload>(user.id, "undo", { v: "tag", tag, ids: [...done], label: `Removed “${tag}” from ${plural(done.size)}` }) : null,
  };
}

/** Expected close date (feeds the forecast window). Edit access checked in SQL; one audit row per deal; undoable. */
async function runClose(user: AppUser, date: string, ids: string[], ctx: RunCtx): Promise<ExecuteResult> {
  const edit = await dealAccessWhere(user, "edit");
  const before = await db.select({ id: s.deals.id, close: s.deals.expectedCloseDate }).from(s.deals).where(and(edit, inArray(s.deals.id, ids)));
  const at = dateOnlyToInstant(date, safeTz(user.timezone));
  const updated = before.length
    ? await db
        .update(s.deals)
        .set({ expectedCloseDate: at })
        .where(and(edit, inArray(s.deals.id, before.map((b) => b.id))))
        .returning({ id: s.deals.id, accountId: s.deals.accountId })
    : [];
  const prev = new Map(before.map((b) => [b.id, b.close?.toISOString() ?? null]));
  for (const u of updated) await audit({ actorId: user.id, action: "deal.update", entity: "deal", entityId: u.id, before: { expectedCloseDate: prev.get(u.id) }, after: { expectedCloseDate: at.toISOString(), via: "command" } });
  await logFieldChanges(user, updated, `Expected close set to ${date}`, { field: "expectedCloseDate", to: at.toISOString() });
  await recomputeHealthBounded(updated.map((u) => u.id), ctx);
  const done = new Set(updated.map((u) => u.id));
  const rest = ids.filter((id) => !done.has(id));
  const names = await dealNames(user, rest);
  const groups = new Map<string, string[]>();
  for (const id of done) {
    const k = prev.get(id) ?? "";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(id);
  }
  return {
    changed: done.size,
    skipped: rest.map((id) => ({ id, name: names.get(id) ?? "Deal", reason: "Not editable" })),
    message: `Expected close set to ${date} on ${plural(done.size)}`,
    undoToken: done.size ? signToken<UndoPayload>(user.id, "undo", { v: "close", groups: [...groups].map(([d, g]) => ({ date: d || null, expect: at.toISOString(), ids: g })), label: `Restored the close date on ${plural(done.size)}` }) : null,
  };
}

async function runEnroll(user: AppUser, p: Extract<RunPayload, { v: "enroll" }>, ids: string[]): Promise<ExecuteResult> {
  const r = await enrollInSequence({ sequenceId: p.sequenceId, dealIds: ids, source: "command" });
  if (!r.ok) throw new UserError(r.error);
  return {
    changed: r.data.enrolled,
    skipped: r.data.skipped.map((x) => ({ id: x.id, name: x.name, reason: x.reason })),
    message: `${plural(r.data.enrolled, "contact")} enrolled in ${p.sequenceName}`,
    undoToken: r.data.enrollmentIds.length ? signToken<UndoPayload>(user.id, "undo", { v: "enroll", enrollmentIds: r.data.enrollmentIds, label: `Stopped ${plural(r.data.enrollmentIds.length, "enrollment")}` }) : null,
  };
}

/**
 * Undo a command within 15 minutes, through the same bulk actions (permissions/gates re-checked, audited).
 * CR M2: single-use (the token is consumed under a transaction lock, recorded in the audit log) and compare-and-set
 * (records changed since the command are skipped and reported, never overwritten).
 */
export async function undoCommand(user: AppUser, token: string): Promise<{ message: string; changed: number; skipped: ExecuteResult["skipped"] }> {
  const p = verifyToken<UndoPayload>(token, user.id, "undo");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const claim = await withXactLock(`rso.command-undo:${tokenHash}`, async (tx) => {
    const [used] = await tx
      .select({ id: s.auditLog.id })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, "command.undo_claim"), eq(s.auditLog.entity, "command_token"), eq(s.auditLog.entityId, tokenHash)))
      .limit(1);
    if (used) return false;
    await audit({ actorId: user.id, action: "command.undo_claim", entity: "command_token", entityId: tokenHash, after: { verb: p.v } }, tx);
    return true;
  });
  if (!claim.locked || !claim.value) throw new UserError("This change was already undone.");

  let changed = 0;
  const changedSince: string[] = [];
  const failed: ExecuteResult["skipped"] = [];
  const view = await dealAccessWhere(user, "view");
  const current = async (ids: string[], col: "stage" | "owner" | "close") => {
    if (!ids.length) return new Map<string, string | null>();
    const rows = await db
      .select({ id: s.deals.id, stageId: s.deals.stageId, ownerId: s.deals.ownerId, close: s.deals.expectedCloseDate })
      .from(s.deals)
      .where(and(view, inArray(s.deals.id, ids)));
    return new Map(rows.map((r) => [r.id, col === "stage" ? r.stageId : col === "owner" ? r.ownerId : (r.close?.toISOString() ?? null)]));
  };
  if (p.v === "move") {
    for (const g of p.groups) {
      const { eligible, changed: moved } = partitionForUndo(g.ids, await current(g.ids, "stage"), g.expect);
      changedSince.push(...moved);
      for (const part of chunks(eligible)) {
        const r = await bulkMoveStage({ dealIds: part, toStageId: g.toStageId });
        if (!r.ok) throw new UserError(r.error);
        changed += r.data.moved.length;
        failed.push(...r.data.skipped);
      }
    }
  } else if (p.v === "assign") {
    for (const g of p.groups) {
      const { eligible, changed: moved } = partitionForUndo(g.ids, await current(g.ids, "owner"), g.expect);
      changedSince.push(...moved);
      for (const part of chunks(eligible)) {
        const r = await bulkReassign({ dealIds: part, ownerId: g.ownerId });
        if (!r.ok) throw new UserError(r.error);
        changed += r.data.moved.length;
      }
    }
  } else if (p.v === "tag") {
    const edit = await dealAccessWhere(user, "edit");
    const rows = await db
      .update(s.deals)
      .set({ tags: sql`array_remove(${s.deals.tags}, ${p.tag}::text)` })
      .where(and(edit, inArray(s.deals.id, p.ids), sql`${s.deals.tags} @> array[${p.tag}]::text[]`))
      .returning({ id: s.deals.id, accountId: s.deals.accountId });
    for (const r of rows) await audit({ actorId: user.id, action: "deal.tag_remove", entity: "deal", entityId: r.id, after: { tag: p.tag, via: "command_undo" } });
    await logFieldChanges(user, rows, `Tag removed: ${p.tag}`, { field: "tags", tag: p.tag, undo: true });
    changed = rows.length;
  } else if (p.v === "close") {
    const edit = await dealAccessWhere(user, "edit");
    for (const g of p.groups) {
      const cur = await current(g.ids, "close");
      // Compare instants (ISO strings may differ in format only).
      const normalized = new Map([...cur].map(([k, v]) => [k, v && g.expect && Date.parse(v) === Date.parse(g.expect) ? g.expect : v]));
      const { eligible, changed: moved } = partitionForUndo(g.ids, normalized, g.expect);
      changedSince.push(...moved);
      if (!eligible.length) continue;
      const rows = await db
        .update(s.deals)
        .set({ expectedCloseDate: g.date ? new Date(g.date) : null })
        .where(and(edit, inArray(s.deals.id, eligible), g.expect ? eq(s.deals.expectedCloseDate, new Date(g.expect)) : undefined))
        .returning({ id: s.deals.id, accountId: s.deals.accountId });
      for (const r of rows) await audit({ actorId: user.id, action: "deal.update", entity: "deal", entityId: r.id, after: { expectedCloseDate: g.date, via: "command_undo" } });
      await logFieldChanges(user, rows, g.date ? `Expected close restored to ${g.date.slice(0, 10)}` : "Expected close cleared", { field: "expectedCloseDate", to: g.date, undo: true });
      await recomputeHealthBounded(rows.map((r) => r.id), { deadline: Date.now() + 15_000 });
      changed += rows.length;
    }
  } else {
    const r = await stopEnrollments({ ids: p.enrollmentIds });
    if (!r.ok) throw new UserError(r.error);
    changed = r.data.changed;
  }
  const names = await dealNames(user, changedSince);
  const skipped = [...changedSince.map((id) => ({ id, name: names.get(id) ?? "Deal", reason: "Changed since — kept the newer edit" })), ...failed];
  await audit({ actorId: user.id, action: "command.undo", entity: "command", entityId: tokenHash, after: { verb: p.v, changed, skippedChanged: changedSince.length } });
  const base = p.v === "enroll" ? `${p.label} (emails already sent stay sent)` : p.label;
  return { message: changedSince.length ? `${base} · ${changedSince.length} changed since and kept` : base, changed, skipped };
}
