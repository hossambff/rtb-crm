"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { checkClaims, type ClaimHit } from "@/lib/claims";
import { assertCan, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { GMAIL_SEND_SCOPE } from "@/lib/integrations/core";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { getGoogleAccessToken } from "@/lib/integrations/google";
import { getPrefs } from "@/lib/integrations/store";
import { runUserSync } from "@/lib/integrations/sync-runner";
import { getMessage, sendMessage } from "./client";
import { buildRawEmailBase64Url, buildReferences, replySubject } from "./mime";
import { ingestParsedMessage, loadIngestContext, refreshThreadState } from "./ingest";
import { analyzeStoredMessage, createCommitmentTask, type StoredEmailAnalysis } from "./analyze";
import { parseGmailMessage } from "./parse";
import { expireSignalsForSources } from "@/lib/signals/service";
import { accountNoun, collisionHeadline, describeTouch, getRecentTouches, getRecentTouchesForDeal, latestPerPerson } from "@/lib/deals/collisions";
import { internalDomains } from "@/lib/integrations/directory";
import { PERSONAL_DOMAINS } from "@/lib/integrations/matching-core";

async function ownThread(user: AppUser, threadId: string) {
  await assertCan(user, "email", "view");
  const [t] = await db.select().from(s.emailThreads).where(eq(s.emailThreads.id, threadId));
  if (!t) throw new UserError("Thread not found.");
  if (t.mailboxUserId !== user.id) throw new ForbiddenError("Only the mailbox owner can change this thread.");
  return t;
}

export const syncInboxNow = action(z.object({}), async (_i, user) => {
  await assertCan(user, "email", "view");
  const r = await runUserSync(user.id, { analyzeLimit: 30 });
  revalidatePath("/inbox");
  const err = [r.gmail, r.calendar].find((x) => x && "error" in x) as { error: string } | undefined;
  if (err) throw new UserError(err.error);
  const g = r.gmail && "ingested" in r.gmail ? r.gmail : null;
  return { ingested: g?.ingested ?? 0, scanned: g?.scanned ?? 0, done: g?.done ?? true, analyzed: r.analyzed ?? 0 };
});

const emailList = z.array(z.email("Invalid email address").max(254)).max(50);

export type SendEmailResult = { status: "sent"; threadRowId: string | null } | { status: "confirm"; hits: ClaimHit[] };

/**
 * EML-8: send through the user's Gmail. Claims guardrail first — banned claims in "block" mode refuse with the approved
 * alternative; any other hit requires an explicit confirm. Replies keep the Gmail thread (threadId + In-Reply-To/References).
 */
export const sendEmail = action(
  z.object({
    to: emailList.min(1, "Add at least one recipient"),
    cc: emailList.default([]),
    subject: z.string().trim().max(300).default(""),
    body: z.string().trim().min(1, "Write a message").max(50_000),
    threadId: z.uuid().nullable().optional(),
    dealId: z.uuid().nullable().optional(),
    confirmed: z.boolean().default(false),
  }),
  async (input, user): Promise<SendEmailResult> => {
    await assertCan(user, "email", "view");
    const claims = await checkClaims(`${input.subject}\n${input.body}`);
    if (claims.blocked) {
      const banned = claims.hits.filter((h) => h.status === "banned");
      throw new UserError(
        `Blocked by the claims policy: ${banned
          .map((h) => `“${h.match}”${h.alternative ? ` → use “${h.alternative}”` : ""}`)
          .join("; ")}. Edit the message and try again.`,
      );
    }
    if (claims.hits.length && !input.confirmed) return { status: "confirm", hits: claims.hits };

    let dealId = input.dealId ?? null;
    if (dealId && !(await getAccessibleDeal(user, dealId, "view"))) throw new ForbiddenError("You can't log email to that deal.");

    const token = await getGoogleAccessToken(user.id, GMAIL_SEND_SCOPE).catch((e: Error) => {
      throw new UserError(e.message);
    });
    let subject = input.subject;
    let gmailThreadId: string | null = null;
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (input.threadId) {
      const t = await ownThread(user, input.threadId);
      gmailThreadId = t.gmailThreadId;
      dealId = dealId ?? t.dealId;
      subject = subject || replySubject(t.subject);
      const [last] = await db
        .select({ gmailMessageId: s.emailMessages.gmailMessageId })
        .from(s.emailMessages)
        .where(eq(s.emailMessages.threadId, t.id))
        .orderBy(desc(s.emailMessages.sentAt))
        .limit(1);
      if (last) {
        const parent = parseGmailMessage(await getMessage(token, last.gmailMessageId, "metadata"));
        inReplyTo = parent.messageIdHeader;
        references = buildReferences(parent.references, parent.messageIdHeader);
      }
    }
    if (!subject) throw new UserError("Add a subject.");

    const prefs = await getPrefs(user.id);
    const sig = prefs.signature.trim();
    const body = sig && !input.body.includes(sig) ? `${input.body}\n\n${sig}` : input.body;
    const raw = buildRawEmailBase64Url({ from: user.email, fromName: user.name, to: input.to, cc: input.cc, subject, body, inReplyTo, references });
    const sent = await sendMessage(token, raw, gmailThreadId);

    const ctx = await loadIngestContext(user.id);
    const r = await ingestParsedMessage(
      ctx,
      {
        id: sent.id,
        threadId: sent.threadId,
        historyId: null,
        labelIds: sent.labelIds ?? ["SENT"],
        subject,
        from: user.email.toLowerCase(),
        fromName: user.name,
        to: input.to.map((e) => e.toLowerCase()),
        cc: input.cc.map((e) => e.toLowerCase()),
        sentAt: new Date(),
        messageIdHeader: null,
        references,
        snippet: body.slice(0, 200),
        bodyText: body,
      },
      { force: true, dealId },
    );
    await audit({
      actorId: user.id,
      action: "email.send",
      entity: "email_thread",
      entityId: r.status === "ingested" ? r.threadRowId : undefined,
      after: { to: input.to.length, cc: input.cc.length, subject, dealId, claimsConfirmed: claims.hits.length > 0 },
    });
    revalidatePath("/inbox");
    return { status: "sent", threadRowId: r.status === "ingested" || r.status === "duplicate" ? r.threadRowId : null };
  },
);

/** EML-4: link/unlink a thread to a deal the user can view; keeps the thread's email activities in sync. */
export const linkThreadToDeal = action(z.object({ threadId: z.uuid(), dealId: z.uuid().nullable() }), async ({ threadId, dealId }, user) => {
  const t = await ownThread(user, threadId);
  let accountId = t.accountId;
  if (dealId) {
    const deal = await getAccessibleDeal(user, dealId, "view");
    if (!deal) throw new ForbiddenError("You can't link to that deal.");
    accountId = deal.accountId ?? accountId;
  }
  await db.update(s.emailThreads).set({ dealId, accountId }).where(eq(s.emailThreads.id, threadId));
  const msgIds = (await db.select({ id: s.emailMessages.id }).from(s.emailMessages).where(eq(s.emailMessages.threadId, threadId))).map((m) => m.id);
  if (msgIds.length) {
    await db.update(s.activities).set({ dealId, accountId }).where(inArray(s.activities.emailMessageId, msgIds));
    await db
      .update(s.tasks)
      .set({ dealId, accountId })
      .where(and(eq(s.tasks.origin, "email_ai"), inArray(s.tasks.evidenceSource, msgIds.map((id) => `email:${id}`))));
    // Signals detected while the thread pointed at another deal no longer apply.
    await expireSignalsForSources("email", msgIds, { dealId });
  }
  await audit({ actorId: user.id, action: dealId ? "email.link_deal" : "email.unlink_deal", entity: "email_thread", entityId: threadId, before: { dealId: t.dealId }, after: { dealId } });
  revalidatePath("/inbox");
  return true;
});

/**
 * EML-3/11: mark a thread private — deletes its logged activities, strips stored bodies/analysis and stops future
 * logging. Un-marking only resumes logging for new messages.
 */
export const setThreadPrivate = action(z.object({ threadId: z.uuid(), private: z.boolean() }), async (input, user) => {
  const t = await ownThread(user, input.threadId);
  if (input.private) {
    const msgIds = (await db.select({ id: s.emailMessages.id }).from(s.emailMessages).where(eq(s.emailMessages.threadId, t.id))).map((m) => m.id);
    if (msgIds.length) {
      await db.delete(s.activities).where(inArray(s.activities.emailMessageId, msgIds));
      await db
        .update(s.tasks)
        .set({ status: "cancelled" })
        .where(and(eq(s.tasks.origin, "email_ai"), eq(s.tasks.status, "open"), inArray(s.tasks.evidenceSource, msgIds.map((id) => `email:${id}`))));
      await db.update(s.emailMessages).set({ bodyText: null, analysis: null }).where(inArray(s.emailMessages.id, msgIds));
      await expireSignalsForSources("email", msgIds, { scrubQuotes: true }); // pending signals + their quotes go too

    }
    await db.update(s.emailThreads).set({ private: true, snippet: null, aiIntent: null, awaitingReplyFrom: "none", dealId: null }).where(eq(s.emailThreads.id, t.id));
  } else {
    await db.update(s.emailThreads).set({ private: false }).where(eq(s.emailThreads.id, t.id));
  }
  await audit({ actorId: user.id, action: input.private ? "email.mark_private" : "email.unmark_private", entity: "email_thread", entityId: t.id });
  revalidatePath("/inbox");
  return true;
});

/** Autonomy level 1 (suggest): the user accepts an extracted commitment as a task. */
export const createTaskFromCommitment = action(z.object({ messageId: z.uuid(), index: z.number().int().min(0).max(50) }), async ({ messageId, index }, user) => {
  const [row] = await db
    .select({ m: s.emailMessages, t: s.emailThreads })
    .from(s.emailMessages)
    .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
    .where(eq(s.emailMessages.id, messageId));
  if (!row) throw new UserError("Message not found.");
  if (row.t.mailboxUserId !== user.id) throw new ForbiddenError("Only the mailbox owner can create tasks from this email.");
  await assertCan(user, "tasks", "create");
  const analysis = row.m.analysis as StoredEmailAnalysis | null;
  const c = analysis?.commitments?.[index];
  if (!c) throw new UserError("That commitment no longer exists.");
  const taskId = await createCommitmentTask({ commitment: c, messageRowId: messageId, assigneeId: user.id, createdBy: user.id, dealId: row.t.dealId, accountId: row.t.accountId });
  await db
    .update(s.emailMessages)
    .set({ analysis: { ...analysis, taskIds: { ...(analysis?.taskIds ?? {}), [String(index)]: taskId } } as unknown as Record<string, unknown> })
    .where(eq(s.emailMessages.id, messageId));
  await audit({ actorId: user.id, action: "task.create_from_email", entity: "task", entityId: taskId, after: { evidenceSource: `email:${messageId}` } });
  revalidatePath("/inbox");
  return { taskId };
});

/** Undo an auto-created (email_ai) task — "auto + notify, undo" (§11.4). */
export const undoEmailTask = action(z.object({ taskId: z.uuid() }), async ({ taskId }, user) => {
  const [t] = await db.select().from(s.tasks).where(and(eq(s.tasks.id, taskId), eq(s.tasks.origin, "email_ai"), like(s.tasks.evidenceSource, "email:%")));
  if (!t) throw new UserError("Task not found.");
  if (t.assigneeId !== user.id) throw new ForbiddenError();
  await db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, taskId));
  await audit({ actorId: user.id, action: "task.undo_email_ai", entity: "task", entityId: taskId });
  revalidatePath("/inbox");
  return true;
});

/** Re-run analysis on demand for one message (e.g. after AI was unavailable). */
export const reanalyzeMessage = action(z.object({ messageId: z.uuid() }), async ({ messageId }, user) => {
  const [row] = await db
    .select({ threadId: s.emailMessages.threadId, owner: s.emailThreads.mailboxUserId })
    .from(s.emailMessages)
    .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
    .where(eq(s.emailMessages.id, messageId));
  if (!row) throw new UserError("Message not found.");
  if (row.owner !== user.id) throw new ForbiddenError();
  const r = await analyzeStoredMessage(messageId);
  await refreshThreadState(row.threadId);
  revalidatePath("/inbox");
  return { engine: r?.engine ?? null };
});

export type ComposerCollision = { headline: string; people: { name: string; line: string }[] };

/**
 * V2 C4 in the composer: "Chris emailed this publisher 2 days ago" — someone else on the team touched the account
 * we're about to email. Account resolved from the deal, the thread, or the recipients' company domain. Names, kinds and
 * dates only (getRecentTouches skips private threads and restricted deals the user can't see). Null when clear.
 */
export const composerCollisions = action(
  z.object({ dealId: z.uuid().nullable().optional(), threadId: z.uuid().nullable().optional(), to: z.array(z.string().max(254)).max(20).default([]) }),
  async (input, user): Promise<ComposerCollision | null> => {
    let accountId: string | null = null;
    let accountType: string | null = null;
    let touches: Awaited<ReturnType<typeof getRecentTouches>> = [];
    if (input.dealId) {
      const r = await getRecentTouchesForDeal(user, input.dealId);
      touches = r.touches;
      accountType = r.accountType;
    } else {
      if (input.threadId) {
        const [t] = await db.select({ accountId: s.emailThreads.accountId, owner: s.emailThreads.mailboxUserId }).from(s.emailThreads).where(eq(s.emailThreads.id, input.threadId));
        if (t?.owner === user.id) accountId = t.accountId;
      }
      if (!accountId) {
        const internal = await internalDomains(user.email);
        const domains = [...new Set(input.to.map((e) => e.trim().toLowerCase().split("@")[1] ?? "").filter((d) => /^[a-z0-9.-]{3,253}$/.test(d) && !PERSONAL_DOMAINS.has(d) && !internal.includes(d)))].slice(0, 10);
        if (domains.length) {
          const [a] = await db
            .select({ id: s.accounts.id })
            .from(s.accounts)
            .where(and(isNull(s.accounts.deletedAt), or(inArray(s.accounts.domain, domains), sql`${s.accounts.altDomains} && string_to_array(${domains.join(",")}, ',')`)))
            .limit(1);
          accountId = a?.id ?? null;
        }
      }
      if (accountId) {
        touches = await getRecentTouches(user, accountId);
        if (touches.length) {
          const [a] = await db.select({ type: s.accounts.type }).from(s.accounts).where(eq(s.accounts.id, accountId));
          accountType = a?.type ?? null;
        }
      }
    }
    const now = new Date();
    const noun = accountNoun(accountType);
    const headline = collisionHeadline(touches, now, noun);
    if (!headline) return null;
    return { headline, people: latestPerPerson(touches).slice(0, 4).map((p) => ({ name: p.userName, line: describeTouch(p, now, noun) })) };
  },
);
