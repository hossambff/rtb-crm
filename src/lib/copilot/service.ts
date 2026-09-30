import "server-only";
import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiText, untrusted } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { checkClaims } from "@/lib/claims";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { scopeFor, type AppUser } from "@/lib/rbac/server";
import { autonomyDecision, canAssignTo, clip, gateIssues, isUuid, looksLikeInjection, scanMnpi } from "./guards";
import { agendaFor, likelyObjections } from "./playbook";
import {
  accountAccessible,
  contactFlagsForEmails,
  getDealDetail,
  getTimeline,
  loadAccessibleDeal,
  logDenied,
  stagesOfPipeline,
  suppressed,
  userNames,
  type RunState,
} from "./queries";
import type { CreateTaskOutput, EmailDraft, MeetingBrief, StageSuggestionOutput, TaskSuggestion } from "./types";
import { recomputeDealHealth } from "@/lib/deals/service";

/* ───────────── tasks ───────────── */

export type TaskInput = { title: string; dueAt?: string | null; dealId?: string | null; assigneeId?: string | null; description?: string | null; evidence?: string | null };

/** Validate a task request against the acting user's permissions. Returns a normalized suggestion or an error. */
export async function validateTask(user: AppUser, input: TaskInput): Promise<{ ok: true; task: TaskSuggestion; dealAccountId: string | null } | { ok: false; error: string }> {
  if ((await scopeFor(user, "tasks", "create")) === "none") return { ok: false, error: "Your role cannot create tasks." };
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: "Task title is required." };
  let dueAt: string | null = null;
  if (input.dueAt) {
    const d = new Date(input.dueAt);
    if (Number.isNaN(d.getTime())) return { ok: false, error: `Invalid due date "${input.dueAt}". Use ISO-8601.` };
    dueAt = d.toISOString();
  }
  let dealName: string | null = null;
  let dealAccountId: string | null = null;
  if (input.dealId) {
    const deal = await loadAccessibleDeal(user, input.dealId, "view");
    if (!deal) return { ok: false, error: "Deal not found or outside your access." };
    dealName = deal.name;
    dealAccountId = deal.accountId;
  }
  const assigneeId = input.assigneeId && input.assigneeId !== user.id ? input.assigneeId : user.id;
  if (assigneeId !== user.id) {
    const assignScope = await scopeFor(user, "tasks", "assign");
    if (!canAssignTo(user, assignScope, assigneeId)) return { ok: false, error: "You can only create tasks for yourself (no assign permission for that person)." };
  }
  const names = await userNames([assigneeId]);
  if (!names.has(assigneeId)) return { ok: false, error: "Assignee not found." };
  return {
    ok: true,
    dealAccountId,
    task: {
      title,
      description: input.description?.slice(0, 2000) ?? null,
      dueAt,
      dealId: input.dealId ?? null,
      dealName,
      assigneeId,
      assigneeName: names.get(assigneeId) ?? null,
      evidence: input.evidence?.slice(0, 1000) ?? null,
    },
  };
}

export async function insertTask(user: AppUser, task: TaskSuggestion, accountId: string | null, actorKind: "agent" | "user") {
  const [row] = await db
    .insert(s.tasks)
    .values({
      title: task.title,
      description: task.description ?? null,
      dueAt: task.dueAt ? new Date(task.dueAt) : null,
      assigneeId: task.assigneeId,
      createdBy: user.id,
      dealId: task.dealId ?? null,
      accountId,
      origin: "agent",
      evidence: task.evidence ?? null,
      evidenceSource: "copilot",
    })
    .returning({ id: s.tasks.id });
  await audit({ actorId: user.id, actorKind, action: "task.create", entity: "task", entityId: row!.id, after: { ...task, via: "copilot" } });
  if (task.dealId) await recomputeDealHealth(task.dealId);
  return row!.id;
}

export async function agentCreateTask(user: AppUser, run: RunState, input: TaskInput): Promise<CreateTaskOutput> {
  const v = await validateTask(user, input);
  if (!v.ok) return { mode: "refused", error: v.error };
  const autonomy = await getSetting<Record<string, number>>("agent.autonomy", {});
  const decision = autonomyDecision(autonomy.task_from_commitment, run.untrustedSeen);
  if (decision === "refuse") return { mode: "refused", error: "Task creation by Copilot is turned off (autonomy level 0) by your admin." };
  if (decision === "suggest")
    return {
      mode: "suggest",
      task: v.task,
      note: run.untrustedSeen
        ? "Shown as a suggestion because this conversation processed external content (emails/transcripts/web) — the user must click Create."
        : "Autonomy level 1: the user must click Create to add this task.",
    };
  const id = await insertTask(user, v.task, v.dealAccountId, "agent");
  return { mode: "created", taskId: id, task: v.task, href: v.task.dealId ? `/deals/${v.task.dealId}` : "/tasks", note: "Created automatically (autonomy level 2). The user can undo within 24h." };
}

/* ───────────── stage suggestions ───────────── */

export async function buildStageSuggestion(user: AppUser, run: RunState, dealId: string, stageKey: string, reason: string): Promise<StageSuggestionOutput> {
  const deal = await loadAccessibleDeal(user, dealId, "view");
  if (!deal) {
    await logDenied(user, run, "suggest_stage_change", "deal", dealId);
    return { mode: "refused", error: "Deal not found or outside your access." };
  }
  const editable = await loadAccessibleDeal(user, dealId, "edit");
  if (!editable) return { mode: "refused", error: "You can view this deal but not edit it, so you can't change its stage. Ask the owner." };
  const stages = await stagesOfPipeline(deal.pipelineId);
  const target = stages.find((st) => st.key === stageKey || st.name.toLowerCase() === stageKey.toLowerCase());
  if (!target) return { mode: "refused", error: `Unknown stage "${stageKey}" for ${deal.pipelineKey}. Valid stages: ${stages.map((st) => `${st.key} (${st.name})`).join(", ")}` };
  if (target.id === deal.stageId) return { mode: "refused", error: `The deal is already in "${target.name}".` };
  return {
    mode: "suggest",
    suggestion: {
      dealId: deal.id,
      dealName: deal.name,
      pipelineKey: deal.pipelineKey,
      fromStage: { key: deal.stageKey, name: deal.stageName },
      toStage: { key: target.key, name: target.name, category: target.category },
      reason: reason.slice(0, 500),
      gateIssues: gateIssues(target, deal),
      requiresApproval: target.requiresApproval,
    },
    note: "Not applied. The user must click Apply; the change is re-checked against permissions and stage gates.",
  };
}

/* ───────────── email drafts ───────────── */

export async function buildEmailDraft(
  user: AppUser,
  run: RunState,
  input: { to: string; subject: string; purpose: string; dealId?: string | null; body?: string | null },
): Promise<EmailDraft | { error: string }> {
  let context = "";
  if (input.dealId) {
    const deal = await getDealDetail(user, run, input.dealId);
    if ("error" in deal) return { error: deal.error ?? "Deal not accessible." };
    context = [
      `Deal: ${deal.name} (${deal.pipeline.name}, stage ${deal.stage.name})`,
      deal.account ? `Account: ${deal.account.name}` : "",
      deal.nextStep ? `Our next step: ${deal.nextStep}` : "",
      deal.stakeholders.length ? `Stakeholders: ${deal.stakeholders.map((c) => `${c.name}${c.title ? ` (${c.title})` : ""}`).join(", ")}` : "",
      deal.notesAndSummaries ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  let body = input.body?.trim() ?? "";
  let engine = "ai:composed-in-chat";
  if (!body) {
    if (aiAvailable()) {
      try {
        const approved = await db.select({ text: s.claims.text }).from(s.claims).where(eq(s.claims.status, "approved"));
        body = await aiText({
          kind: "copilot_draft",
          userId: user.id,
          tier: "fast",
          prompt: [
            `Write the BODY ONLY (plain text, no subject line, no markdown) of a short, warm, professional sales email from ${user.name} at Roundtable (RTB Digital).`,
            `To: ${input.to}`,
            `Subject: ${input.subject}`,
            `Purpose: ${input.purpose}`,
            context ? `Context (facts you may use):\n${context}` : "",
            `Only use these approved proof points if relevant: ${approved.map((a) => a.text).join("; ") || "none"}.`,
            "Do not invent numbers, dates, guarantees or product capabilities. Keep it under 160 words. Sign off with the sender's first name.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        engine = "ai:fast";
      } catch {
        body = "";
      }
    }
    if (!body) {
      engine = "heuristic";
      const first = input.to.split("@")[0]?.split(/[._-]/)[0] ?? "";
      body = `Hi ${first ? first[0]!.toUpperCase() + first.slice(1) : "there"},\n\n${input.purpose.trim()}\n\nWould you have 20 minutes this week or next to continue the conversation?\n\nBest,\n${user.name.split(" ")[0]}`;
    }
  }
  const claims = await checkClaims(`${input.subject}\n${body}`);
  const recipients = input.to.split(/[,;\s]+/).filter((e) => e.includes("@"));
  const [flags, supp] = await Promise.all([contactFlagsForEmails(user, recipients), suppressed(recipients)]);
  const contactWarnings = [
    ...flags.filter((f) => f.doNotContact).map((f) => `${f.name} (${f.email}) is marked Do Not Contact`),
    ...flags.filter((f) => f.status === "left_company").map((f) => `${f.name} (${f.email}) has left the company`),
    ...supp.map((x) => `${x.value} is on the suppression list`),
  ];
  return {
    to: input.to,
    subject: input.subject,
    body,
    dealId: input.dealId ?? null,
    claims: { mode: claims.mode, blocked: claims.blocked, hits: claims.hits },
    mnpiWarnings: scanMnpi(`${input.subject}\n${body}`),
    contactWarnings,
    engine,
  };
}

/* ───────────── web research ───────────── */

export async function webResearch(run: RunState, query: string) {
  if (!env.apifyToken) return { configured: false, message: "web research not configured (APIFY_TOKEN is not set)." };
  const q = query.trim().slice(0, 200);
  if (!q) return { configured: true, error: "Empty query." };
  try {
    const url = `https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items?token=${encodeURIComponent(env.apifyToken)}&timeout=45`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q, maxResults: 3, outputFormats: ["markdown"] }),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    if (!res.ok) return { configured: true, error: `Web research failed (HTTP ${res.status}).` };
    const items = (await res.json()) as { metadata?: { url?: string; title?: string }; searchResult?: { url?: string; title?: string; description?: string }; markdown?: string; text?: string }[];
    run.untrustedSeen = true;
    const results = items.slice(0, 3).map((it) => {
      const text = clip(it.markdown ?? it.text ?? it.searchResult?.description ?? "", 2500);
      if (looksLikeInjection(text)) run.injectionFlags++;
      const url = it.metadata?.url ?? it.searchResult?.url ?? "";
      return { url, title: it.metadata?.title ?? it.searchResult?.title ?? url, content: untrusted(`web:${url}`, text, 3000) };
    });
    return { configured: true, label: "research estimate", query: q, results };
  } catch (e) {
    return { configured: true, error: `Web research failed: ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "request error"}.` };
  }
}

/* ───────────── meeting prep (CARD-9) ───────────── */

function fmtInZone(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }).format(d);
  } catch {
    return d.toISOString();
  }
}

export async function meetingPrep(user: AppUser, run: RunState, input: { meetingId?: string | null; dealId?: string | null }): Promise<MeetingBrief | { error: string }> {
  let meeting: typeof s.meetings.$inferSelect | null = null;
  let dealId = input.dealId ?? null;
  if (input.meetingId) {
    if (!isUuid(input.meetingId)) return { error: "Invalid meeting id." };
    const [m] = await db.select().from(s.meetings).where(eq(s.meetings.id, input.meetingId));
    let allowed = Boolean(m && m.ownerId === user.id);
    if (m && !allowed && m.dealId) allowed = Boolean(await loadAccessibleDeal(user, m.dealId, "view"));
    if (m && !allowed && m.accountId) allowed = await accountAccessible(user, m.accountId);
    if (!m || !allowed) {
      await logDenied(user, run, "meeting_prep", "meeting", input.meetingId);
      return { error: "Meeting not found or outside your access." };
    }
    meeting = m;
    dealId = m.dealId ?? dealId;
  } else if (dealId) {
    if (!(await loadAccessibleDeal(user, dealId, "view"))) {
      await logDenied(user, run, "meeting_prep", "deal", dealId);
      return { error: "Deal not found or outside your access." };
    }
    const [m] = await db
      .select()
      .from(s.meetings)
      .where(and(eq(s.meetings.dealId, dealId), gte(s.meetings.startsAt, new Date(Date.now() - 2 * 3_600_000))))
      .orderBy(asc(s.meetings.startsAt))
      .limit(1);
    meeting = m ?? null;
  } else {
    // next meeting owned by the user
    const [m] = await db
      .select()
      .from(s.meetings)
      .where(and(eq(s.meetings.ownerId, user.id), gte(s.meetings.startsAt, new Date(Date.now() - 2 * 3_600_000))))
      .orderBy(asc(s.meetings.startsAt))
      .limit(1);
    if (!m) return { error: "No upcoming meeting found for you. Pass a meetingId or dealId." };
    meeting = m;
    dealId = m.dealId;
    if (dealId && !(await loadAccessibleDeal(user, dealId, "view"))) dealId = null;
  }

  const deal = dealId ? await getDealDetail(user, run, dealId) : null;
  const dealOk = deal && !("error" in deal) ? deal : null;
  const timeline = dealOk ? await getTimeline(user, run, { dealId: dealOk.id, limit: 10 }) : meeting?.accountId ? await getTimeline(user, run, { accountId: meeting.accountId, limit: 10 }) : null;
  const tl = timeline && !("error" in timeline) ? timeline : null;

  const attendeeEmails = (meeting?.attendees ?? []).map((e) => e.toLowerCase());
  const contactRows = attendeeEmails.length
    ? await db
        .select({ email: s.contacts.email, name: s.contacts.fullName, title: s.contacts.title })
        .from(s.contacts)
        .where(and(isNull(s.contacts.deletedAt), inArray(s.contacts.email, attendeeEmails)))
    : [];
  const roleByEmail = new Map((dealOk?.stakeholders ?? []).map((c) => [c.email?.toLowerCase() ?? "", c.role]));
  const attendees = attendeeEmails.map((email) => {
    const c = contactRows.find((r) => r.email?.toLowerCase() === email);
    return { email, name: c?.name ?? null, title: c?.title ?? null, role: roleByEmail.get(email) ?? null };
  });
  if (!attendees.length && dealOk) for (const c of dealOk.stakeholders.slice(0, 6)) attendees.push({ email: c.email ?? "", name: c.name, title: c.title, role: c.role });

  const productRows = await db
    .select({ text: s.claims.text, evidence: s.claims.evidence, expiresAt: s.claims.expiresAt, pipelineKeys: s.products.pipelineKeys })
    .from(s.claims)
    .leftJoin(s.products, eq(s.products.id, s.claims.productId))
    .where(and(eq(s.claims.status, "approved"), or(isNull(s.claims.expiresAt), gte(s.claims.expiresAt, new Date()))));
  const pk = dealOk?.pipeline.key ?? null;
  const proofPoints = productRows.filter((p) => !pk || !p.pipelineKeys || p.pipelineKeys.length === 0 || p.pipelineKeys.includes(pk)).map((p) => ({ text: p.text, evidence: p.evidence }));

  const objections = likelyObjections({ pipelineKey: pk, text: tl?.content ?? "", max: 4 }).map((o) => ({ id: o.id, objection: o.objection, rebuttal: o.rebuttal }));
  const openItems = (dealOk?.openTasks ?? []).slice(0, 8).map((t) => ({ title: t.title, owedBy: t.owedBy, dueAt: t.dueAt }));
  const agenda = [...agendaFor(dealOk?.stage.key)];
  const weOwe = openItems.filter((t) => t.owedBy === "us").slice(0, 2);
  if (weOwe.length) agenda.splice(1, 0, `Close out what we owe: ${weOwe.map((t) => t.title).join("; ")}`);
  const history = (tl?.items ?? []).slice(0, 8).map((i) => ({ date: i.date ?? "", type: i.type, summary: `${i.type}${i.direction ? ` (${i.direction})` : ""} via ${i.source}${i.actor ? ` · ${i.actor}` : ""}` }));

  const title = meeting?.title ?? (dealOk ? `Next meeting — ${dealOk.name}` : "Meeting");
  const md: string[] = [];
  md.push(`## ${title}`);
  md.push(
    [meeting?.startsAt ? `**When:** ${fmtInZone(meeting.startsAt, user.timezone)}` : "**When:** not scheduled", dealOk ? `**Deal:** [${dealOk.name}](${dealOk.href}) · ${dealOk.pipeline.key} · ${dealOk.stage.name}` : null]
      .filter(Boolean)
      .join("  \n"),
  );
  md.push("### Attendees");
  md.push(attendees.length ? attendees.map((a) => `- ${a.name ?? a.email}${a.title ? ` — ${a.title}` : ""}${a.role ? ` (${a.role.replace(/_/g, " ")})` : ""}`).join("\n") : "- No attendees recorded");
  md.push("### Recent history");
  md.push(history.length ? history.map((h) => `- ${h.date.slice(0, 10)} · ${h.summary}`).join("\n") : "- No logged activity yet");
  md.push("### Open items");
  md.push(openItems.length ? openItems.map((t) => `- ${t.title}${t.owedBy ? ` (${t.owedBy === "us" ? "we owe" : "they owe"})` : ""}${t.dueAt ? ` · due ${t.dueAt.slice(0, 10)}` : ""}`).join("\n") : "- None");
  md.push("### Suggested agenda");
  md.push(agenda.map((a, i) => `${i + 1}. ${a}`).join("\n"));
  md.push("### Approved proof points");
  md.push(proofPoints.length ? proofPoints.map((p) => `- ${p.text}${p.evidence ? ` — _${p.evidence}_` : ""}`).join("\n") : "- None in the claim library for this motion");
  md.push("### Likely objections");
  md.push(objections.map((o) => `- **${o.objection}**\n  ${o.rebuttal}`).join("\n"));
  const markdown = md.join("\n\n");

  let stored = false;
  if (meeting) {
    await db.update(s.meetings).set({ prepBrief: markdown }).where(eq(s.meetings.id, meeting.id));
    await audit({ actorId: user.id, actorKind: "agent", action: "meeting.prep_brief", entity: "meeting", entityId: meeting.id, after: { chars: markdown.length } });
    stored = true;
  }
  return {
    meetingId: meeting?.id ?? null,
    dealId: dealOk?.id ?? null,
    title,
    startsAt: meeting?.startsAt ? meeting.startsAt.toISOString() : null,
    attendees,
    history,
    openItems,
    agenda,
    proofPoints,
    objections,
    markdown,
    stored,
    engine: "heuristic",
  };
}

