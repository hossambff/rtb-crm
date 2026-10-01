import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { dealValue } from "@/lib/pipeline-math";
import { can, dealAccessWhere, dealModule, getHiddenFields, scopeFor, type AppUser } from "@/lib/rbac/server";
import { commandFieldHidden } from "./undo-core";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { canAssignTo } from "@/lib/deals/service";
import { getPicklist, getStagesByPipeline } from "@/lib/deals/queries";
import { filledKeys, GATE_FIELDS, gateFieldMeta, missingFields, reasonPicklist } from "@/lib/deals/gates";
import { listEnrollableSequences } from "@/lib/sequences/queries";
import { aiParseCommand } from "./ai-parse";
import { dealFilterConds, loadVocab } from "./filter";
import { matchUser, parseCommand, resolveCloseDate, resolveStageTarget, userCandidates, type Vocab } from "./parse";
import { localDateKey, safeTz } from "@/lib/time";
import { signToken } from "./token";
import { describeFilter, MAX_COMMAND_RECORDS, MAX_ENROLL_RECORDS, type Command, type DealFilter, type ParseOutcome, type Preview, type PreviewRow } from "./types";

/** What a confirmed preview may run (signed into the token). */
export type RunPayload =
  | { v: "move"; ids: string[]; stageByPipeline: Record<string, string>; stageName: string; category: "open" | "won" | "lost" | "hold"; text: string; engine: string }
  | { v: "assign"; ids: string[]; ownerId: string; ownerName: string; text: string; engine: string }
  | { v: "tag"; ids: string[]; tag: string; text: string; engine: string }
  | { v: "close"; ids: string[]; date: string; text: string; engine: string }
  | { v: "enroll"; ids: string[]; sequenceId: string; sequenceName: string; text: string; engine: string };

/** Parse a sentence: rules first; the AI only when the rules left words unplaced (or found no verb). */
export async function parseText(user: AppUser, text: string, vocab: Vocab): Promise<ParseOutcome> {
  const rules = parseCommand(text, vocab);
  if (rules.command && rules.leftovers.length === 0) return rules;
  // SEC M-6: the AI fallback honours the copilot.use_ai permission (admin overrides included).
  if (!(await can(user, "copilot", "use_ai"))) return rules;
  const ai = await aiParseCommand(text, vocab, user.id);
  if (ai) return { command: ai.command, leftovers: [], engine: `ai:${ai.model}` };
  return rules;
}

/** Owner names (from the AI or a filter) → user ids; "me"/"none" pass through. Throws on ambiguity. */
function normalizeFilter(f: DealFilter, v: Vocab): DealFilter {
  if (!f.owner || f.owner === "me" || f.owner === "none" || v.users.some((u) => u.id === f.owner)) return f;
  const id = matchUser(f.owner, v);
  if (!id) {
    const c = userCandidates(f.owner, v);
    throw new UserError(c.length ? `Which ${f.owner}? ${c.map((x) => x.name).join(", ")}` : `No user called “${f.owner}”.`);
  }
  return { ...f, owner: id === v.meId ? "me" : id };
}

const hasNarrowing = (f: DealFilter) =>
  Boolean(f.ids || f.pipelineKeys?.length || f.stageNames?.length || f.owner || f.ownerIds?.length || f.team || f.idleDays || f.overdue || f.noNextStep || f.noCloseDate || f.healthBelow || f.priority || f.tag || f.text);

/**
 * Build the preview for a structured command: the permission-filtered records it would touch (dealAccessWhere view —
 * restricted deals only for their access list), each marked will-change / skipped-with-reason (edit access, assign
 * scope, gates, already there), plus a signed token for exactly the actionable records.
 */
export async function buildPreview(user: AppUser, commandIn: Command, opts: { engine: ParseOutcome["engine"]; leftovers?: string[]; text?: string; vocab?: Vocab }): Promise<Preview> {
  const vocab = opts.vocab ?? (await loadVocab(user));
  const command = { ...commandIn, filter: normalizeFilter(commandIn.filter, vocab) } as Command;
  const f = command.filter;
  const ownerName = f.owner && f.owner !== "me" && f.owner !== "none" ? (vocab.users.find((u) => u.id === f.owner)?.name ?? null) : null;
  const filterText = describeFilter(f, { owner: ownerName });
  const warnings: string[] = [];
  if (opts.leftovers?.length) warnings.push(`Ignored: “${opts.leftovers.slice(0, 8).join(" ")}” — the selection may be broader than you meant. Check the list.`);
  if (!hasNarrowing(f) && command.verb !== "show") warnings.push(`This applies to every ${f.status && f.status !== "open" ? f.status : "open"} deal you can see.`);
  if (f.ids && f.ids.length === 0) warnings.push("Nothing is selected — select rows on the Deals list first.");
  for (const n of f.stageNames ?? []) if (!vocab.stages.some((st) => st.name.toLowerCase() === n.toLowerCase())) warnings.push(`No stage called “${n}”.`);

  const base: Omit<Preview, "summary" | "rows" | "total" | "actionable" | "token"> = { command, engine: opts.engine, filterText, warnings, needsReason: null, undoable: false };
  if (command.verb === "show") {
    return { ...base, summary: `Show ${filterText}`, rows: [], total: 0, actionable: 0, token: "", href: `/deals?${filterToParams(f).toString()}` };
  }

  const view = await dealAccessWhere(user, "view");
  const edit = await dealAccessWhere(user, "edit");
  const conds = and(view, ...dealFilterConds(user, f))!;
  const [{ n: total } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(conds);
  const cap = command.verb === "enroll" ? MAX_ENROLL_RECORDS : MAX_COMMAND_RECORDS;
  if (total > cap) {
    return {
      ...base,
      warnings: [...warnings, `Matches ${total.toLocaleString("en-US")} deals — ${command.verb === "enroll" ? "enrollment" : "commands"} run on at most ${cap}. Add a filter (motion, owner, stage, idle days).`],
      summary: summaryFor(command, total, null),
      rows: [],
      total,
      actionable: 0,
      token: "",
    };
  }
  const owner = alias(s.user, "cmd_owner");
  const rows = total
    ? await db
        .select({
          deal: s.deals,
          accountName: s.accounts.name,
          pipelineKey: s.pipelines.key,
          pipeline: s.pipelines,
          stage: s.stages,
          ownerName: owner.name,
          canEdit: sql<boolean>`(${edit})`,
        })
        .from(s.deals)
        .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
        .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .leftJoin(owner, eq(owner.id, s.deals.ownerId))
        .where(conds)
        .orderBy(asc(s.pipelines.sortOrder), desc(s.deals.updatedAt))
        .limit(cap)
    : [];

  const now = Date.now();
  const out: PreviewRow[] = rows.map((r) => {
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
    const last = r.deal.lastActivityAt ?? r.deal.createdAt;
    return {
      id: r.deal.id,
      name: r.deal.name,
      accountName: r.accountName,
      pipelineKey: r.pipelineKey,
      stageName: r.stage.name,
      ownerName: r.ownerName,
      idleDays: Math.max(0, Math.floor((now - last.getTime()) / 86_400_000)),
      weightedUsd: v.weightedGrossUsd,
      restricted: r.deal.restricted,
      skip: r.canEdit ? null : "You can't edit this deal",
    };
  });
  const byId = new Map(rows.map((r) => [r.deal.id, r]));

  let payload: RunPayload | null = null;
  let summaryTarget: string | null = null;
  let disabledReason: string | null = null;
  const text = opts.text ?? "";
  if (command.verb === "move") {
    const pipelineKeys = Array.from(new Set(rows.map((r) => r.pipelineKey)));
    const targets = resolveStageTarget(command.toStage, pipelineKeys, vocab.stages);
    if (rows.length && targets.size === 0) throw new UserError(`No stage “${command.toStage}” in ${pipelineKeys.join(", ")}.`);
    const stagesBy = await getStagesByPipeline();
    const stageByPipeline: Record<string, string> = {};
    const categories = new Set<string>();
    const stageNames = new Set<string>();
    const approveScope = new Map<string, boolean>();
    const approvalStages = new Set((await db.select({ id: s.stages.id }).from(s.stages).where(eq(s.stages.requiresApproval, true))).map((x) => x.id));
    for (const row of out) {
      const r = byId.get(row.id)!;
      const t = targets.get(r.pipelineKey);
      const full = t ? (stagesBy[r.pipeline.id] ?? []).find((st) => st.key === t.key) : undefined;
      if (!full) {
        row.skip ??= `No “${command.toStage}” stage in ${r.pipelineKey}`;
        continue;
      }
      stageByPipeline[r.pipeline.id] = full.id;
      categories.add(full.category);
      stageNames.add(full.name);
      if (row.skip) continue;
      if (full.id === r.deal.stageId) {
        row.skip = `Already in ${full.name}`;
        continue;
      }
      const customKeys = full.requiredFields.filter((k) => !(k in GATE_FIELDS));
      const missing = missingFields(full, filledKeys(r.deal as unknown as Record<string, unknown>, customKeys));
      if (missing.length) {
        row.skip = `${full.name} needs: ${missing.map((k) => gateFieldMeta(k).label).join(", ")}`;
        continue;
      }
      if (approvalStages.has(full.id)) {
        if (!approveScope.has(r.pipelineKey)) approveScope.set(r.pipelineKey, SCOPE_RANK[await scopeFor(user, dealModule(r.pipelineKey), "approve")] >= SCOPE_RANK.own);
        if (!approveScope.get(r.pipelineKey)) row.note = "Needs approval — a request will be sent";
      }
    }
    if (categories.size > 1) throw new UserError(`“${command.toStage}” means different kinds of stage across motions — pick one motion.`);
    const category = (categories.values().next().value ?? "open") as "open" | "won" | "lost" | "hold";
    const list = reasonPicklist(category);
    if (category !== "open") base.needsReason = { category, options: list ? await getPicklist(list) : [] };
    base.undoable = category === "open" || category === "hold";
    summaryTarget = Array.from(stageNames).join(" / ") || command.toStage;
    payload = { v: "move", ids: [], stageByPipeline, stageName: summaryTarget, category, text, engine: opts.engine };
  } else if (command.verb === "assign") {
    const id = vocab.users.some((u) => u.id === command.toUser) ? command.toUser : matchUser(command.toUser, vocab);
    if (!id) {
      const c = userCandidates(command.toUser, vocab);
      throw new UserError(c.length ? `Assign to which ${command.toUser}? ${c.map((x) => x.name).join(", ")}` : `No active user called “${command.toUser}”.`);
    }
    const target = vocab.users.find((u) => u.id === id)!;
    const allowed = new Map<string, boolean>();
    for (const row of out) {
      if (row.skip) continue;
      const r = byId.get(row.id)!;
      if (!allowed.has(r.pipelineKey)) {
        const scope = await scopeFor(user, dealModule(r.pipelineKey), "assign");
        allowed.set(r.pipelineKey, scope !== "none" && (await canAssignTo(user, r.pipelineKey, id)));
      }
      if (!allowed.get(r.pipelineKey)) row.skip = `You can't assign ${r.pipelineKey} deals to ${target.name}`;
      else if (r.deal.ownerId === id) row.skip = `Already owned by ${target.name}`;
    }
    summaryTarget = target.name;
    base.undoable = true;
    payload = { v: "assign", ids: [], ownerId: id, ownerName: target.name, text, engine: opts.engine };
  } else if (command.verb === "tag") {
    const tag = command.tag.toLowerCase();
    for (const row of out) if (!row.skip && byId.get(row.id)!.deal.tags.includes(tag)) row.skip = `Already tagged “${tag}”`;
    summaryTarget = `“${tag}”`;
    base.undoable = true;
    payload = { v: "tag", ids: [], tag, text, engine: opts.engine };
  } else if (command.verb === "close") {
    const today = localDateKey(new Date(), safeTz(user.timezone));
    const date = resolveCloseDate(command.date, today);
    if (!date) throw new UserError(`I couldn't read “${command.date}” as a date. Try 2026-12-15, “Dec 15”, “end of quarter” or “end of next quarter”.`);
    if (date < today) warnings.push(`${date} is in the past — those deals will show as “close date passed” in the forecast.`);
    for (const row of out) {
      if (row.skip) continue;
      const cur = byId.get(row.id)!.deal.expectedCloseDate?.toISOString().slice(0, 10);
      if (cur === date) row.skip = `Already closes ${date}`;
      else if (cur) row.note = `was ${cur}`;
    }
    summaryTarget = date;
    base.undoable = true;
    payload = { v: "close", ids: [], date, text, engine: opts.engine };
  } else if (command.verb === "enroll") {
    const seqs = await listEnrollableSequences(user).catch(() => []);
    const q = command.sequence.trim().toLowerCase().replace(/\s+sequence$/, "");
    const seq = seqs.find((x) => x.id === command.sequence) ?? seqs.find((x) => x.name.toLowerCase() === q) ?? seqs.find((x) => x.name.toLowerCase().includes(q)) ?? null;
    if (!seq) {
      disabledReason = seqs.length ? `No active sequence called “${command.sequence}”. Try: ${seqs.slice(0, 4).map((x) => x.name).join(", ")}` : "You have no active sequences you can enroll into yet.";
    } else {
      summaryTarget = seq.name;
      base.undoable = true;
      payload = { v: "enroll", ids: [], sequenceId: seq.id, sequenceName: seq.name, text, engine: opts.engine };
    }
    for (const row of out) if (!row.skip) row.note = "Enrolls the primary contact (or deal contacts) — DNC / suppressed / no-email contacts are skipped";
  }

  // SEC L-5 / CR M3: field-level security — tags / close date hidden for the role → nothing to run.
  const hiddenField = commandFieldHidden(command.verb, await getHiddenFields(user.role, "deal"));
  if (hiddenField) disabledReason = `Your role can't edit ${hiddenField === "tags" ? "tags" : "the expected close date"}.`;
  const actionable = out.filter((r) => !r.skip).map((r) => r.id);
  if (payload) payload.ids = actionable;
  // Actionable first, then skipped (grouped by reason) so the user sees what will happen at a glance.
  out.sort((a, b) => Number(Boolean(a.skip)) - Number(Boolean(b.skip)) || (a.skip ?? "").localeCompare(b.skip ?? ""));
  return {
    ...base,
    summary: summaryFor(command, actionable.length, summaryTarget),
    rows: out,
    total,
    actionable: actionable.length,
    token: payload && actionable.length && !disabledReason ? signToken(user.id, "run", payload) : "",
    disabledReason,
  };
}

function summaryFor(c: Command, n: number, target: string | null): string {
  const deals = `${n.toLocaleString("en-US")} deal${n === 1 ? "" : "s"}`;
  switch (c.verb) {
    case "move":
      return `Move ${deals} to ${target ?? c.toStage}`;
    case "assign":
      return `Assign ${deals} to ${target ?? c.toUser}`;
    case "tag":
      return `Tag ${deals} ${target ?? c.tag}`;
    case "close":
      return `Set the expected close of ${deals} to ${target ?? c.date}`;
    case "enroll":
      return `Enroll ${deals} in ${target ?? c.sequence}`;
    default:
      return `Show ${deals}`;
  }
}

/** Filter ⇄ /deals URL params (the list page reads the same keys). */
export function filterToParams(f: DealFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.pipelineKeys?.length === 1) p.set("motion", f.pipelineKeys[0]!);
  else if (f.pipelineKeys?.length) p.set("motion", f.pipelineKeys.join(","));
  if (f.stageNames?.length) p.set("stage", f.stageNames.join(","));
  if (f.owner) p.set("owner", f.owner);
  if (f.team) p.set("owner", "team");
  if (f.idleDays) p.set("idle", String(f.idleDays));
  if (f.overdue) p.set("overdue", "1");
  if (f.noNextStep) p.set("nonext", "1");
  if (f.noCloseDate) p.set("noclose", "1");
  if (f.healthBelow) p.set("health", String(f.healthBelow));
  if (f.priority) p.set("priority", f.priority);
  if (f.tag) p.set("tag", f.tag);
  if (f.text) p.set("q", f.text);
  if (f.status && f.status !== "open") p.set("status", f.status);
  return p;
}

/** Names for ids (skipped lists from bulk actions, permission-filtered). */
export async function dealNames(user: AppUser, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const view = await dealAccessWhere(user, "view");
  const rows = await db.select({ id: s.deals.id, name: s.deals.name }).from(s.deals).where(and(view, inArray(s.deals.id, ids.slice(0, 500))));
  return new Map(rows.map((r) => [r.id, r.name]));
}
