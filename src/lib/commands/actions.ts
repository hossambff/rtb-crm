"use server";
import { revalidatePath } from "next/cache";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { assertCan, dealAccessWhere } from "@/lib/rbac/server";
import { loadVocab } from "./filter";
import { buildPreview, parseText } from "./service";
import { runCommand, undoCommand } from "./execute";
import { exportDeals } from "./export";
import { commandSchema, dealFilterSchema, MAX_COMMAND_RECORDS } from "./types";

const uuid = z.string().uuid();

/**
 * ⌘K: sentence → structured command → PREVIEW (never executes). Rules parser first, AI (aiObject + zod) only for what
 * the rules couldn't place. `selection` = the deal ids selected on /deals ("these", "selected").
 */
export const previewCommandText = action(z.object({ text: z.string().trim().min(3).max(500), selection: z.array(uuid).max(MAX_COMMAND_RECORDS).optional() }), async ({ text, selection }, user) => {
  const vocab = await loadVocab(user, selection);
  const parsed = await parseText(user, text, vocab);
  if (!parsed.command) throw new UserError("I couldn't turn that into a command. Try “move NET deals idle 30 days to Nurture” or “assign selected deals to Will”.");
  return buildPreview(user, parsed.command, { engine: parsed.engine, leftovers: parsed.leftovers, text, vocab });
});

/** Bulk bar: an explicit structured command (selected ids or the current filter) → the same preview. */
export const previewCommand = action(z.object({ command: commandSchema, label: z.string().max(200).optional() }), async ({ command, label }, user) =>
  buildPreview(user, command, { engine: "rules", text: label ?? `bulk:${command.verb}` }),
);

/** Confirm: runs only what a preview signed (the user may untick rows, never add). */
export const executeCommand = action(
  z.object({ token: z.string().min(10).max(60_000), ids: z.array(uuid).min(1).max(MAX_COMMAND_RECORDS), reasonCode: z.string().max(120).optional(), reasonText: z.string().trim().max(2000).optional() }),
  async (input, user) => {
    const r = await runCommand(user, input);
    revalidatePath("/deals");
    revalidatePath("/pipelines", "layout");
    return r;
  },
);

export const undoCommandAction = action(z.object({ token: z.string().min(10).max(60_000) }), async ({ token }, user) => {
  const r = await undoCommand(user, token);
  revalidatePath("/deals");
  revalidatePath("/pipelines", "layout");
  return r;
});

/** CSV of selected deals / the current filter across motions (export permission; restricted deals never leave). */
export const exportDealsAction = action(z.object({ filter: dealFilterSchema }), async ({ filter }, user) => exportDeals(user, filter));

/** ⌘K "Snooze task": my open tasks (own only), optionally matching a query. */
export const myOpenTasks = action(z.object({ q: z.string().trim().max(100).default("") }), async ({ q }, user) => {
  await assertCan(user, "tasks", "view");
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const view = await dealAccessWhere(user, "view"); // a restricted deal's name never shows to someone off its access list
  return db
    .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, dealName: s.deals.name })
    .from(s.tasks)
    .leftJoin(s.deals, and(eq(s.deals.id, s.tasks.dealId), view))
    .where(and(eq(s.tasks.assigneeId, user.id), eq(s.tasks.status, "open"), q ? or(ilike(s.tasks.title, pat), ilike(s.deals.name, pat)) : undefined))
    .orderBy(sql`${s.tasks.dueAt} asc nulls last`, asc(s.tasks.createdAt))
    .limit(12);
});
