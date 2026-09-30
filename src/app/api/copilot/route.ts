import { NextResponse } from "next/server";
import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type LanguageModel, type UIMessage } from "ai";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, modelFor, RTB_SYSTEM } from "@/lib/ai";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { ROLE_LABELS } from "@/lib/rbac/model";
import { getCurrentUser, scopeFor, type AppUser } from "@/lib/rbac/server";
import { friendlyAiError } from "@/lib/copilot/errors";
import { clip, emailsIn, isUuid, sanitizeHistory } from "@/lib/copilot/guards";
import { checkClaimsWith, loadClaimRules } from "@/lib/claims";
import { looksLikeDraft } from "@/lib/claims-core";
import { buildSystemPrompt } from "@/lib/copilot/prompt";
import { accountAccessible, loadAccessibleDeal, logDenied, newRunState, type RunState } from "@/lib/copilot/queries";
import { copilotBucket } from "@/lib/copilot/rate-limit";
import { buildCopilotTools } from "@/lib/copilot/tools";
import type { CopilotContext } from "@/lib/copilot/types";

export const maxDuration = 60;

const MAX_MESSAGES = 30;
const MAX_STEPS = 8;

async function authorize(): Promise<{ user: AppUser } | { res: Response }> {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return { res: NextResponse.json({ error: "You are not signed in." }, { status: 401 }) };
  if ((await scopeFor(user, "copilot", "use_ai")) === "none") return { res: NextResponse.json({ error: "Your role does not have access to Copilot." }, { status: 403 }) };
  return { user };
}

/** Status for client components (CopilotPanel): who am I, which model, is AI configured. */
export async function GET() {
  const auth = await authorize();
  if ("res" in auth) return auth.res;
  return NextResponse.json({
    userId: auth.user.id,
    model: await modelFor("strong"),
    aiAvailable: aiAvailable(),
    webResearch: Boolean(env.apifyToken),
  });
}

async function contextLines(user: AppUser, run: RunState, ctx: CopilotContext): Promise<string[]> {
  const lines: string[] = [];
  if (ctx.dealId) {
    const d = await loadAccessibleDeal(user, ctx.dealId, "view");
    if (d) lines.push(`Deal "${d.name}" (id ${d.id}, ${d.pipelineKey}, stage ${d.stageName}) — link /deals/${d.id}`);
    else await logDenied(user, run, "context", "deal", ctx.dealId);
  }
  if (ctx.accountId) {
    if (await accountAccessible(user, ctx.accountId)) {
      const [a] = await db.select({ name: s.accounts.name }).from(s.accounts).where(eq(s.accounts.id, ctx.accountId));
      if (a) lines.push(`Account "${a.name}" (id ${ctx.accountId}) — link /accounts/${ctx.accountId}`);
    } else await logDenied(user, run, "context", "account", ctx.accountId);
  }
  if (ctx.meetingId) {
    const [m] = await db.select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, ownerId: s.meetings.ownerId, dealId: s.meetings.dealId }).from(s.meetings).where(eq(s.meetings.id, ctx.meetingId));
    const ok = m && (m.ownerId === user.id || (m.dealId ? Boolean(await loadAccessibleDeal(user, m.dealId, "view")) : false));
    if (m && ok) lines.push(`Meeting "${m.title ?? "Untitled"}" (id ${m.id}${m.startsAt ? `, starts ${m.startsAt.toISOString()}` : ""})`);
  }
  if (ctx.alertId) {
    const [a] = await db
      .select({ title: s.alerts.title, detail: s.alerts.detail, suggestedAction: s.alerts.suggestedAction, entity: s.alerts.entity, entityId: s.alerts.entityId, ruleCode: s.alerts.ruleCode })
      .from(s.alerts)
      .where(and(eq(s.alerts.id, ctx.alertId), eq(s.alerts.recipientId, user.id)));
    if (a) lines.push(`Alert ${a.ruleCode}: "${a.title}"${a.detail ? ` — ${clip(a.detail, 300)}` : ""}${a.suggestedAction ? ` (suggested: ${clip(a.suggestedAction, 200)})` : ""} on ${a.entity} ${a.entityId}`);
  }
  return lines;
}

function sanitizeContext(raw: unknown): CopilotContext {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: CopilotContext = {};
  for (const k of ["dealId", "accountId", "meetingId", "alertId"] as const) if (isUuid(c[k])) out[k] = c[k] as string;
  return out;
}

/** SEC M-10: did an earlier request of this conversation process external/untrusted content? (server-side record) */
async function chatSawUntrusted(userId: string, chatId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(s.agentRuns)
      .where(
        and(
          eq(s.agentRuns.userId, userId),
          eq(s.agentRuns.kind, "copilot_chat"),
          gte(s.agentRuns.createdAt, new Date(Date.now() - 7 * 86_400_000)),
          sql`${s.agentRuns.input}->>'chatId' = ${chatId}`,
          sql`(coalesce((${s.agentRuns.output}->>'untrustedSeen')::boolean, false) or coalesce((${s.agentRuns.output}->>'injectionFlags')::int, 0) > 0)`,
        ),
      );
    return (row?.n ?? 0) > 0;
  } catch {
    return true; // fail closed: keep write tools at "suggest"
  }
}

function lastUserText(messages: UIMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return (m?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

export async function POST(req: Request) {
  const auth = await authorize();
  if ("res" in auth) return auth.res;
  const { user } = auth;

  if (!aiAvailable()) {
    return NextResponse.json({ error: "AI is not configured for this workspace (no AI Gateway key). Quick actions still work.", code: "ai_unavailable" }, { status: 503 });
  }

  const bucket = copilotBucket.take(user.id);
  if (!bucket.ok) {
    return NextResponse.json({ error: `You're sending messages too quickly. Try again in ${bucket.retryAfterSec}s.`, code: "rate_limited" }, { status: 429, headers: { "retry-after": String(bucket.retryAfterSec) } });
  }
  const hourlyCap = await getSetting<number>("agent.chat_hourly_cap", 60);
  const [{ n }] = await db
    .select({ n: count() })
    .from(s.agentRuns)
    .where(and(eq(s.agentRuns.userId, user.id), eq(s.agentRuns.kind, "copilot_chat"), gte(s.agentRuns.createdAt, new Date(Date.now() - 3_600_000))));
  if (n >= hourlyCap) {
    return NextResponse.json({ error: `Hourly Copilot limit reached (${hourlyCap} requests). Try again later.`, code: "rate_limited" }, { status: 429 });
  }

  let body: { messages?: unknown; context?: unknown; id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return NextResponse.json({ error: "messages[] is required." }, { status: 400 });
  // SEC M-10 / S-04: the browser-supplied history is untrusted — strip forged roles/parts and replay prior tool results
  // only as <untrusted> data; the chat id keys the server-side record of whether external content was already seen.
  const sanitized = sanitizeHistory((body.messages as UIMessage[]).slice(-MAX_MESSAGES));
  const messages = sanitized.messages;
  if (!messages.length || messages[messages.length - 1]!.role !== "user") return NextResponse.json({ error: "The last message must be from the user." }, { status: 400 });
  const context = sanitizeContext(body.context);
  const chatId = typeof body.id === "string" && body.id.length > 0 && body.id.length <= 120 ? body.id : null;

  const run = newRunState();
  run.untrustedSeen = sanitized.untrustedSeen || (chatId ? await chatSawUntrusted(user.id, chatId) : false);
  run.userTypedEmails = emailsIn(messages.filter((m) => m.role === "user").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")).join(" "));
  const claimRules = await loadClaimRules();
  let assistantText = "";
  const started = Date.now();
  const model = await modelFor("strong");
  let logged = false;
  const finalize = async (out: { text?: string; steps?: number; usage?: unknown; error?: string }) => {
    if (logged) return;
    logged = true;
    try {
      await db.insert(s.agentRuns).values({
        kind: "copilot_chat",
        userId: user.id,
        model,
        input: { context, chatId, messages: messages.length, lastUser: clip(lastUserText(messages), 500) } as never,
        toolCalls: run.toolCalls as never,
        output: { text: clip(out.text ?? "", 4000), steps: out.steps, usage: out.usage, denied: run.denied, untrustedSeen: run.untrustedSeen, injectionFlags: run.injectionFlags } as never,
        latencyMs: Date.now() - started,
        error: out.error ?? null,
      });
    } catch (e) {
      console.error("[copilot] failed to log agent run", e instanceof Error ? e.message : e);
    }
  };

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
  } catch {
    return NextResponse.json({ error: "Could not read the conversation. Start a new chat." }, { status: 400 });
  }

  const instructions = buildSystemPrompt({
    base: RTB_SYSTEM,
    now: new Date(),
    timezone: user.timezone,
    userName: user.name,
    roleLabel: ROLE_LABELS[user.role],
    contextLines: await contextLines(user, run, context),
    webResearchEnabled: Boolean(env.apifyToken),
  });

  const tools = buildCopilotTools(user, run);
  const result = streamText({
    model: model as LanguageModel,
    instructions,
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: req.signal,
    onEnd: async (e) => {
      await finalize({ text: e.text, steps: e.stepNumber + 1, usage: e.usage });
    },
    onError: async ({ error }) => {
      console.error("[copilot] stream error", error instanceof Error ? error.message : error);
      await finalize({ error: friendlyAiError(error, model) });
    },
    onAbort: async () => {
      await finalize({ error: "aborted by user" });
    },
  });

  // QA-02: accumulate the assistant text so the claim guardrail can run on the finished answer (not only on
  // draft_email): drafts written directly in chat get a warning banner via message metadata.
  const tapped = result.stream.pipeThrough(
    new TransformStream<(typeof result.stream extends ReadableStream<infer P> ? P : never), (typeof result.stream extends ReadableStream<infer P> ? P : never)>({
      transform(part, controller) {
        if (part.type === "text-delta" && assistantText.length < 60_000) assistantText += part.text;
        controller.enqueue(part);
      },
    }),
  );

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: tapped,
      tools,
      onError: (error) => friendlyAiError(error, model),
      messageMetadata: ({ part }) => {
        if (part.type === "start") return { model };
        if (part.type === "finish") {
          if (!looksLikeDraft(assistantText)) return undefined;
          const check = checkClaimsWith(assistantText, claimRules);
          if (check.hits.length) return { model, claims: { mode: check.mode, blocked: check.blocked, hits: check.hits } };
        }
        return undefined;
      },
    }),
  });
}
