import "server-only";
import { z } from "zod";
import { aiAvailable, aiObject, modelFor } from "@/lib/ai";
import { logServerError } from "@/lib/errors";
import { PRIORITIES, commandSchema, type Command } from "./types";
import type { Vocab } from "./parse";

/**
 * AI enhancement for ⌘K commands: turns a sentence the rules parser couldn't fully place into the same structured
 * command (aiObject + zod). Only internal vocabulary goes into the prompt (motion keys, stage names, user names) — no
 * deal data. The result is validated with the same zod schema, then previewed like any other command; the AI never
 * executes anything. Returns null when AI is unavailable or fails (callers fall back to the rules parse).
 */
const aiSchema = z.object({
  verb: z.enum(["move", "assign", "tag", "close", "enroll", "show", "none"]).describe("none = not a bulk deal command"),
  useSelection: z.boolean().describe("true when the user says these/selected/this selection"),
  pipelineKeys: z.array(z.string()).describe("motion keys from the list, empty = all"),
  stageNames: z.array(z.string()).describe("current-stage filter, exact names from the list"),
  owner: z.string().describe('"me", "none" (unassigned), "team", an exact user name from the list, or "" for anyone'),
  idleDays: z.number().int().describe("no activity in more than N days, 0 = not used"),
  overdue: z.boolean(),
  noNextStep: z.boolean(),
  noCloseDate: z.boolean().describe("deals without an expected close date"),
  healthBelow: z.number().int().describe("0 = not used"),
  priority: z.enum([...PRIORITIES, ""]),
  tagFilter: z.string().describe("only deals with this tag, '' = not used"),
  text: z.string().describe("deal/account name contains, '' = not used"),
  status: z.enum(["open", "won", "lost", "hold", "any"]),
  toStage: z.string().describe("move: target stage name from the list, or won/lost/hold"),
  toUser: z.string().describe('assign: exact user name from the list or "me"'),
  tag: z.string().describe("tag: the tag to add"),
  sequence: z.string().describe("enroll: sequence name"),
  closeDate: z.string().describe('close: new expected close date as YYYY-MM-DD or a phrase like "end of quarter"'),
});

export async function aiParseCommand(text: string, v: Vocab, userId: string): Promise<{ command: Command; model: string } | null> {
  if (!aiAvailable()) return null;
  const prompt = [
    "Convert the user's request into ONE structured bulk command over CRM deals. Use only names from the lists.",
    "If the request is not a bulk deal command (a question, a search, a single-record action), return verb=none.",
    "Never invent filters the user didn't ask for. 'idle/stale/no activity for N days' → idleDays. Weeks = 7 days, months = 30.",
    `Motions (key: name): ${v.pipelines.map((p) => `${p.key}: ${p.name}`).join("; ")}`,
    `Stages by motion: ${v.pipelines.map((p) => `${p.key} → ${v.stages.filter((s) => s.pipelineKey === p.key).map((s) => s.name).join(", ")}`).join(" | ")}`,
    `Users: ${v.users.map((u) => u.name).slice(0, 200).join(", ")}`,
    "",
    `Request: ${text.slice(0, 500)}`,
  ].join("\n");
  try {
    const o = await aiObject({ kind: "command_parse", userId, tier: "fast", prompt, schema: aiSchema, maxOutputTokens: 2500 });
    if (o.verb === "none") return null;
    const userByName = new Map(v.users.map((u) => [u.name.toLowerCase(), u.id]));
    const owner = o.owner === "me" || o.owner === "none" ? o.owner : o.owner && o.owner !== "team" ? (userByName.get(o.owner.toLowerCase()) ?? o.owner) : undefined;
    const filter = {
      ...(o.useSelection ? { ids: (v.selection ?? []).slice(0, 500) } : {}),
      ...(o.pipelineKeys.length ? { pipelineKeys: o.pipelineKeys.filter((k) => v.pipelines.some((p) => p.key === k)) } : {}),
      ...(o.stageNames.length ? { stageNames: o.stageNames.slice(0, 10) } : {}),
      ...(owner ? { owner } : {}),
      ...(o.owner === "team" ? { team: true } : {}),
      ...(o.idleDays > 0 ? { idleDays: Math.min(3650, o.idleDays) } : {}),
      ...(o.overdue ? { overdue: true } : {}),
      ...(o.noNextStep ? { noNextStep: true } : {}),
      ...(o.noCloseDate ? { noCloseDate: true } : {}),
      ...(o.healthBelow > 0 ? { healthBelow: Math.min(100, o.healthBelow) } : {}),
      ...(o.priority ? { priority: o.priority } : {}),
      ...(o.tagFilter ? { tag: o.tagFilter.toLowerCase().slice(0, 60) } : {}),
      ...(o.text ? { text: o.text.slice(0, 120) } : {}),
      ...(o.status !== "open" ? { status: o.status } : {}),
    };
    const raw =
      o.verb === "move"
        ? { verb: "move", filter, toStage: o.toStage }
        : o.verb === "assign"
          ? { verb: "assign", filter, toUser: o.toUser }
          : o.verb === "tag"
            ? { verb: "tag", filter, tag: o.tag }
            : o.verb === "close"
              ? { verb: "close", filter, date: o.closeDate }
            : o.verb === "enroll"
              ? { verb: "enroll", filter, sequence: o.sequence }
              : { verb: "show", filter };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return null;
    return { command: parsed.data, model: await modelFor("fast") };
  } catch (e) {
    logServerError("commands.ai-parse", e);
    return null;
  }
}
