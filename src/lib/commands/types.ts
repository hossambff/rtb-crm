/**
 * ⌘K commands & bulk actions (V2 A8) — the structured command a sentence or a bulk-bar click turns into.
 * Pure + client-safe. Nothing runs from here: a command is always previewed (permission-filtered list of affected
 * records), then confirmed, then executed through the existing bulk actions.
 */
import { z } from "zod";

export const MAX_COMMAND_RECORDS = 500;
export const MAX_ENROLL_RECORDS = 100; // WS-D's enroll cap

export const PRIORITIES = ["top10", "high", "medium", "low"] as const;

/** Which deals a command applies to. Every field narrows (AND). Names are resolved server-side. */
export const dealFilterSchema = z.object({
  ids: z.array(z.string().uuid()).max(MAX_COMMAND_RECORDS).optional(),
  pipelineKeys: z.array(z.string().max(20)).max(10).optional(),
  stageNames: z.array(z.string().max(80)).max(10).optional(),
  /** "me" | "none" | a person's name (resolved) */
  owner: z.string().max(80).optional(),
  ownerIds: z.array(z.string().max(100)).max(50).optional(),
  team: z.boolean().optional(),
  /** No activity in more than N days. */
  idleDays: z.number().int().min(1).max(3650).optional(),
  overdue: z.boolean().optional(),
  noNextStep: z.boolean().optional(),
  noCloseDate: z.boolean().optional(),
  healthBelow: z.number().int().min(1).max(100).optional(),
  priority: z.enum(PRIORITIES).optional(),
  tag: z.string().max(60).optional(),
  text: z.string().max(120).optional(),
  status: z.enum(["open", "won", "lost", "hold", "any"]).optional(),
});
export type DealFilter = z.infer<typeof dealFilterSchema>;

export const VERBS = ["move", "assign", "tag", "close", "enroll", "show"] as const;
export type Verb = (typeof VERBS)[number];

export const commandSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("move"), filter: dealFilterSchema, toStage: z.string().min(1).max(80) }),
  z.object({ verb: z.literal("assign"), filter: dealFilterSchema, toUser: z.string().min(1).max(80) }),
  z.object({ verb: z.literal("tag"), filter: dealFilterSchema, tag: z.string().trim().min(1).max(40) }),
  /** Set the expected close date: an ISO date or a phrase ("end of quarter", "Dec 15"), resolved at preview. */
  z.object({ verb: z.literal("close"), filter: dealFilterSchema, date: z.string().min(1).max(40) }),
  z.object({ verb: z.literal("enroll"), filter: dealFilterSchema, sequence: z.string().min(1).max(120) }),
  z.object({ verb: z.literal("show"), filter: dealFilterSchema }),
]);
export type Command = z.infer<typeof commandSchema>;

export type ParseOutcome = {
  command: Command | null;
  /** Words the parser could not place — non-empty means "ask the AI" (or show what was ignored). */
  leftovers: string[];
  engine: "rules" | `ai:${string}`;
};

/** A row in the preview list (only fields the user may see; restricted deals only for the access list). */
export type PreviewRow = {
  id: string;
  name: string;
  accountName: string | null;
  pipelineKey: string;
  stageName: string;
  ownerName: string | null;
  idleDays: number | null;
  weightedUsd: number;
  restricted: boolean;
  /** Why this record will be skipped (permissions, gates, already there); null = will change. */
  skip: string | null;
  /** Non-blocking note (e.g. "needs approval — a request will be sent"). */
  note?: string | null;
};

export type Preview = {
  command: Command;
  engine: ParseOutcome["engine"];
  summary: string;
  /** Plain-language reading of the filter, e.g. "open NET deals · idle > 30 days". */
  filterText: string;
  total: number;
  rows: PreviewRow[];
  actionable: number;
  warnings: string[];
  /** Move to lost/hold needs a picklist reason; won needs a note. */
  needsReason: null | { category: "won" | "lost" | "hold"; options: { value: string; label: string }[] };
  undoable: boolean;
  /** Opaque, signed: what the server will run on confirm (≤ 15 min). */
  token: string;
  /** For "show": where to open the list. */
  href?: string;
  /** For enroll: the resolved sequence, when WS-D's API is available. */
  disabledReason?: string | null;
};

export type ExecuteResult = {
  changed: number;
  skipped: { id: string; name: string; reason: string }[];
  message: string;
  undoToken: string | null;
  /** CR M4: ids not reached within the time budget — run again with the same token to continue. */
  remaining?: string[];
};

export function describeFilter(f: DealFilter, names: { owner?: string | null } = {}): string {
  const parts: string[] = [];
  const status = f.status ?? "open";
  if (f.ids?.length) parts.push(`${f.ids.length} selected deal${f.ids.length === 1 ? "" : "s"}`);
  else parts.push(`${status === "any" ? "all" : status} ${f.pipelineKeys?.length ? f.pipelineKeys.join("/") + " " : ""}deals`);
  if (f.ids?.length && f.pipelineKeys?.length) parts.push(f.pipelineKeys.join("/"));
  if (f.stageNames?.length) parts.push(`in ${f.stageNames.join(" or ")}`);
  if (f.owner === "me") parts.push("owned by me");
  else if (f.owner === "none") parts.push("unassigned");
  else if (f.owner) parts.push(`owned by ${names.owner ?? f.owner}`);
  if (f.team) parts.push("my team's");
  if (f.idleDays) parts.push(`idle > ${f.idleDays} days`);
  if (f.overdue) parts.push("next step overdue");
  if (f.noNextStep) parts.push("no next step");
  if (f.noCloseDate) parts.push("no close date");
  if (f.healthBelow) parts.push(`health < ${f.healthBelow}`);
  if (f.priority) parts.push(`${f.priority === "top10" ? "Top 10" : f.priority} priority`);
  if (f.tag) parts.push(`tagged “${f.tag}”`);
  if (f.text) parts.push(`matching “${f.text}”`);
  return parts.join(" · ");
}
