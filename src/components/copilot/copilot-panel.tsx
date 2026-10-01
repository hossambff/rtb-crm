"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Expand, Loader2, Sparkles } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { CopilotContext } from "@/lib/copilot/types";
import { CopilotChat } from "./copilot-chat";

type Status = { userId: string; model: string; aiAvailable: boolean } | { error: string };

function threadKeyFor(ctx: CopilotContext): string {
  if (ctx.dealId) return `deal-${ctx.dealId}`;
  if (ctx.accountId) return `account-${ctx.accountId}`;
  if (ctx.meetingId) return `meeting-${ctx.meetingId}`;
  if (ctx.alertId) return `alert-${ctx.alertId}`;
  return "panel";
}

function fullPageHref(ctx: CopilotContext): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(ctx)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `/copilot?${q}` : "/copilot";
}

const RECORD_PROMPTS: Record<string, string[]> = {
  deal: ["Summarize where this deal stands", "What should my next step be?", "Prep me for the next meeting on this deal", "Draft a follow-up email for this deal"],
  account: ["Summarize this account", "Which deals are open with this account?", "Who are our contacts here and when did we last talk?"],
  meeting: ["Prep me for this meeting", "What objections should I expect?"],
  default: ["What's at risk in my pipeline this week?", "What do I owe people today?"],
};

/**
 * Right-side Copilot sheet for record pages. Embed via <CopilotButton context={{ dealId }} /> or control it yourself
 * with <CopilotPanel open onOpenChange context />. The conversation is stored per record in localStorage.
 */
export function CopilotPanel({
  open,
  onOpenChange,
  context = {},
  contextLabel,
  initialPrompt,
  promptNonce,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: CopilotContext;
  contextLabel?: string;
  initialPrompt?: string;
  promptNonce?: string;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!open || status) return;
    let cancelled = false;
    fetch("/api/copilot", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as Status;
        if (!cancelled) setStatus(r.ok ? j : { error: "error" in j ? j.error : "Copilot is unavailable." });
      })
      .catch(() => !cancelled && setStatus({ error: "Copilot is unavailable." }));
    return () => {
      cancelled = true;
    };
  }, [open, status]);
  const kind = context.dealId ? "deal" : context.accountId ? "account" : context.meetingId ? "meeting" : "default";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right" className="flex max-w-lg flex-col p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Copilot</DialogTitle>
        <DialogDescription className="sr-only">Ask Copilot about this record.</DialogDescription>
        <div className="absolute right-11 top-2.5 z-10">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Open full-page Copilot">
            <Link href={fullPageHref(context)} onClick={() => onOpenChange(false)}>
              <Expand />
            </Link>
          </Button>
        </div>
        {!status ? (
          <div className="flex flex-1 items-center justify-center text-muted">
            <Loader2 className="size-5 animate-spin" aria-label="Loading Copilot" />
          </div>
        ) : "error" in status ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">{status.error}</div>
        ) : (
          <CopilotChat
            variant="panel"
            userId={status.userId}
            model={status.model}
            aiEnabled={status.aiAvailable}
            context={context}
            contextLabel={contextLabel}
            threadKey={threadKeyFor(context)}
            initialPrompt={initialPrompt}
            promptNonce={promptNonce}
            starterPrompts={RECORD_PROMPTS[kind]}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Ask Copilot" button that opens the side sheet with record context. */
export function CopilotButton({
  context = {},
  contextLabel,
  label = "Ask Copilot",
  initialPrompt,
  variant = "secondary",
  size = "sm",
  className,
}: {
  context?: CopilotContext;
  contextLabel?: string;
  label?: string;
  initialPrompt?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState<string>();
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => {
          setNonce(crypto.randomUUID());
          setOpen(true);
        }}
      >
        <Sparkles /> {label}
      </Button>
      <CopilotPanel
        open={open}
        onOpenChange={setOpen}
        context={context}
        contextLabel={contextLabel}
        initialPrompt={open ? initialPrompt : undefined}
        promptNonce={nonce}
      />
    </>
  );
}
