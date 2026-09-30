"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { AlertTriangle, ArrowUp, RotateCcw, Square, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CopilotContext } from "@/lib/copilot/types";
import { Markdown } from "./markdown";
import { collectRefs, ToolPart } from "./tool-parts";

export const STARTER_PROMPTS = [
  "What's at risk in my pipeline this week?",
  "Prep me for my next meeting",
  "Which Top-10 deals have no meeting in 14 days?",
  "Show my open NET pipeline by stage, gross and net",
  "What do I owe people today?",
  "Draft a follow-up to my most recent hot deal",
];

const STORAGE_PREFIX = "rtb.copilot.v1";
const MAX_STORED = 60;

function loadThread(key: string): UIMessage[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as UIMessage[]) : [];
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.id === "string" && Array.isArray(m.parts)) : [];
  } catch {
    return [];
  }
}
function saveThread(key: string, messages: UIMessage[]) {
  try {
    if (!messages.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(messages.slice(-MAX_STORED)));
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

/** Parse errors from the route (JSON body) or the stream (plain message). */
function describeError(error: Error | undefined): string | null {
  if (!error) return null;
  const msg = error.message ?? "";
  try {
    const j = JSON.parse(msg) as { error?: string };
    if (j.error) return j.error;
  } catch {
    /* not JSON */
  }
  return msg || "Something went wrong.";
}

export type CopilotChatProps = {
  userId: string;
  model: string;
  aiEnabled: boolean;
  context: CopilotContext;
  threadKey: string;
  initialPrompt?: string;
  onInitialPromptSent?: () => void;
  variant?: "page" | "panel";
  contextLabel?: string | null;
  starterPrompts?: string[];
};

const noopSubscribe = () => () => {};
/** true on the client after hydration, false during SSR — without a setState-in-effect. */
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Copilot chat (used by the /copilot page and CopilotPanel). The thread is persisted per user + thread key in
 * localStorage, so the chat renders client-only (restored messages would otherwise mismatch the server HTML).
 */
export function CopilotChat(props: CopilotChatProps) {
  const isClient = useIsClient();
  const storageKey = `${STORAGE_PREFIX}.${props.userId}.${props.threadKey}`;
  if (!isClient)
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", props.variant !== "panel" ? "rounded-lg border border-border bg-surface-1" : "")}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="font-display text-lg italic text-fg">Copilot</span>
        </div>
        <div className="flex-1" />
      </div>
    );
  return <ChatInner key={storageKey} storageKey={storageKey} {...props} />;
}

function ChatInner({
  storageKey,
  model,
  aiEnabled,
  context,
  threadKey,
  initialPrompt,
  onInitialPromptSent,
  variant = "page",
  contextLabel,
  starterPrompts = STARTER_PROMPTS,
}: CopilotChatProps & { storageKey: string }) {
  const [transport] = useState(() => new DefaultChatTransport({ api: "/api/copilot" }));
  const [restored] = useState(() => loadThread(storageKey));
  const { messages, sendMessage, status, stop, error, setMessages, regenerate, clearError } = useChat({
    id: storageKey,
    messages: restored,
    transport,
    throttle: 40,
  });
  const [input, setInput] = useState("");
  const sentInitial = useRef(false);
  const latest = useRef({ context, initialPrompt, onInitialPromptSent });
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    latest.current = { context, initialPrompt, onInitialPromptSent };
  }, [context, initialPrompt, onInitialPromptSent]);

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || busy || !aiEnabled) return;
      clearError();
      void sendMessage({ text: t }, { body: { context: latest.current.context } });
      setInput("");
    },
    [busy, aiEnabled, sendMessage, clearError],
  );

  // Send the ?q= seed prompt once.
  useEffect(() => {
    const { initialPrompt: seed } = latest.current;
    if (!seed || sentInitial.current || !aiEnabled) return;
    // Deferred + cancellable so React StrictMode's mount/unmount/mount sends exactly once.
    // Session guard: a reload (or the router restoring ?q=) must not resend the same seed prompt.
    const seedKey = `${storageKey}.seed.${seed.trim().slice(0, 200)}`;
    const timer = setTimeout(() => {
      if (sentInitial.current) return;
      sentInitial.current = true;
      try {
        if (sessionStorage.getItem(seedKey)) return;
        sessionStorage.setItem(seedKey, "1");
      } catch {
        /* storage unavailable — send once per mount */
      }
      void sendMessage({ text: seed.trim() }, { body: { context: latest.current.context } });
      latest.current.onInitialPromptSent?.();
    }, 0);
    return () => clearTimeout(timer);
  }, [storageKey, sendMessage, aiEnabled]);

  // Persist when idle.
  useEffect(() => {
    if (busy) return;
    saveThread(storageKey, messages);
  }, [messages, busy, storageKey]);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // Auto-size the composer.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const errorText = describeError(error);
  const isModelError = errorText ? /model|gateway|plan|AI/i.test(errorText) : false;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", variant === "page" ? "rounded-lg border border-border bg-surface-1" : "")}>
      <div className={cn("flex items-center justify-between gap-2 border-b border-border px-4 py-2.5", variant === "panel" && "pr-20")}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-display text-lg italic text-fg">Copilot</span>
          {contextLabel ? <span className="truncate text-xs text-muted">· {contextLabel}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          {variant === "page" ? <span className="hidden text-[11px] text-muted sm:inline">{model}</span> : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New chat"
            title="New chat"
            disabled={busy || messages.length === 0}
            onClick={() => {
              setMessages([]);
              saveThread(storageKey, []);
              clearError();
            }}
          >
            <SquarePen />
          </Button>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
            <p className="font-display text-2xl italic text-fg">How can I help?</p>
            <p className="mt-1 text-sm text-muted">Ask about your deals, pipeline, meetings and follow-ups. I only see what you can see.</p>
            <div className={cn("mt-6 grid w-full gap-2", variant === "page" ? "sm:grid-cols-2" : "")}>
              {starterPrompts.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!aiEnabled}
                  onClick={() => send(p)}
                  className="rounded-md border border-border px-3 py-2 text-left text-[13px] text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {status === "submitted" ? (
              <div className="flex items-center gap-2 pl-1 text-xs text-muted">
                <span className="inline-flex gap-1" aria-hidden>
                  <span className="size-1.5 animate-pulse rounded-full bg-secondary" />
                  <span className="size-1.5 animate-pulse rounded-full bg-secondary [animation-delay:150ms]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-secondary [animation-delay:300ms]" />
                </span>
                Thinking…
              </div>
            ) : null}
          </div>
        )}
        {errorText ? (
          <div role="alert" className="mx-auto mt-4 flex max-w-3xl items-start gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2.5 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-body">{errorText}</p>
              {isModelError ? (
                <p className="mt-1 text-xs text-muted">
                  Current model: <span className="text-secondary">{model}</span>. Admins can change it in{" "}
                  <Link href="/admin" className="underline underline-offset-2">
                    Admin → AI settings
                  </Link>
                  . Quick actions keep working without AI.
                </p>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={() => void regenerate({ body: { context: latest.current.context } })} disabled={busy}>
              <RotateCcw /> Retry
            </Button>
          </div>
        ) : null}
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        {!aiEnabled ? (
          <p className="mb-2 text-xs text-muted">AI is not configured for this workspace — use the quick actions instead.</p>
        ) : null}
        <div className="flex items-end gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 focus-within:border-border-strong">
          <label htmlFor={`copilot-input-${threadKey}`} className="sr-only">
            Message Copilot
          </label>
          <textarea
            id={`copilot-input-${threadKey}`}
            ref={textarea}
            rows={1}
            value={input}
            disabled={!aiEnabled}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder={aiEnabled ? "Ask Copilot… (Enter to send, Shift+Enter for a new line)" : "AI unavailable"}
            className="max-h-44 min-h-6 flex-1 resize-none bg-transparent text-sm leading-6 text-body placeholder:text-muted focus-visible:outline-none"
          />
          {busy ? (
            <Button type="button" size="icon-sm" variant="secondary" aria-label="Stop generating" onClick={() => void stop()}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" variant="primary" aria-label="Send" disabled={!input.trim() || !aiEnabled}>
              <ArrowUp />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted">Copilot can be wrong. It never sends email or changes deals without your click.</p>
      </form>
    </div>
  );
}

type ChatClaims = { mode: string; blocked: boolean; hits: { claimId: string; claim: string; status: string; match: string; alternative: string | null }[] };

/** QA-02: server-side claim check of the finished assistant text, sent as message metadata. */
function claimsOf(metadata: unknown): ChatClaims | null {
  const c = (metadata as { claims?: ChatClaims } | undefined)?.claims;
  return c && Array.isArray(c.hits) && c.hits.length ? c : null;
}

function ClaimsBanner({ claims }: { claims: ChatClaims }) {
  return (
    <div role="alert" className="mb-2 rounded-md border border-border-strong bg-surface-1 px-3 py-2 text-[13px]">
      <p className="flex items-center gap-1.5 font-medium text-fg">
        <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
        {claims.blocked ? "Blocked claims in this draft — don't send it as written" : "Claim check: this reply contains flagged claims"}
      </p>
      <ul className="mt-1 space-y-1 text-body">
        {claims.hits.map((h) => (
          <li key={h.claimId}>
            <span className="text-secondary">{h.status === "banned" ? "Banned" : "Restricted"}:</span> “{h.match}”
            {h.alternative ? <span className="text-muted"> → use: {h.alternative}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-body">{text}</div>
      </div>
    );
  }
  const refs = new Map<string, { name: string; href: string }>();
  // Sources = records actually read (search hits stay in their chip).
  for (const p of message.parts) if (isToolUIPart(p) && p.state === "output-available" && getToolName(p) !== "search_records") for (const r of collectRefs(p.output)) if (!refs.has(r.href)) refs.set(r.href, r);
  const sources = [...refs.values()].slice(0, 8);
  const claims = claimsOf(message.metadata);
  return (
    <div className="border-l border-white bg-surface-2 py-2.5 pl-4 pr-3 text-sm leading-6 text-body">
      {claims ? <ClaimsBanner claims={claims} /> : null}
      {message.parts.map((part, i) => {
        if (part.type === "text") return part.text ? <Markdown key={i} text={part.text} /> : null;
        if (isToolUIPart(part)) {
          return (
            <ToolPart
              key={part.toolCallId}
              name={getToolName(part)}
              callId={part.toolCallId}
              state={part.state}
              input={part.input}
              output={part.state === "output-available" ? part.output : undefined}
              errorText={part.state === "output-error" ? part.errorText : undefined}
            />
          );
        }
        return null;
      })}
      {sources.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px]">
          <span className="text-muted">Sources</span>
          {sources.map((s) => (
            <Link key={s.href} href={s.href} className="rounded border border-border px-1.5 py-px text-secondary hover:border-border-strong hover:text-fg">
              {s.name}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
