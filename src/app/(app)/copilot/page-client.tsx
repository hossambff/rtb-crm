"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback } from "react";
import { X } from "lucide-react";
import { CopilotChat } from "@/components/copilot/copilot-chat";
import { QuickActions } from "@/components/copilot/quick-actions";
import type { CopilotContext } from "@/lib/copilot/types";

export function CopilotPageClient({
  userId,
  model,
  aiEnabled,
  webResearch,
  context,
  contextLabel,
  initialPrompt,
}: {
  userId: string;
  model: string;
  aiEnabled: boolean;
  webResearch: boolean;
  context: CopilotContext;
  contextLabel: string | null;
  initialPrompt?: string;
}) {
  const pathname = usePathname();
  // Drop ?q= after sending so a reload doesn't resend it; keep record context params.
  const onInitialPromptSent = useCallback(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(context)) if (v) p.set(k, v);
    const qs = p.toString();
    // history.replaceState (not router.replace): changing search params through the router remounts the page and
    // would abort the in-flight chat stream. The chat also guards against resending the same seed in this session.
    window.history.replaceState(window.history.state, "", qs ? `${pathname}?${qs}` : pathname);
  }, [context, pathname]);
  const hasContext = Object.keys(context).length > 0;

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-3.5rem-3rem)] lg:min-h-[520px] lg:flex-row">
      <div className="flex h-[calc(100dvh-10rem-env(safe-area-inset-bottom))] min-h-[440px] min-w-0 flex-col md:h-[75dvh] lg:h-auto lg:min-h-0 lg:flex-1">
        <CopilotChat
          variant="page"
          userId={userId}
          model={model}
          aiEnabled={aiEnabled}
          context={context}
          contextLabel={contextLabel}
          threadKey="main"
          initialPrompt={initialPrompt}
          onInitialPromptSent={onInitialPromptSent}
        />
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-80">
        {hasContext ? (
          <section className="rounded-lg border border-border bg-surface-1 px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Context</p>
              <Link href="/copilot" className="rounded p-1 text-muted hover:text-fg" aria-label="Clear context">
                <X className="size-3.5" />
              </Link>
            </div>
            <p className="mt-1 text-sm text-body">{contextLabel}</p>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {context.dealId ? (
                <Link href={`/deals/${context.dealId}`} className="text-secondary underline underline-offset-2 hover:text-fg">
                  Open deal
                </Link>
              ) : null}
              {context.accountId ? (
                <Link href={`/accounts/${context.accountId}`} className="text-secondary underline underline-offset-2 hover:text-fg">
                  Open account
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}
        <QuickActions context={context} />
        <section className="rounded-lg border border-border bg-surface-1 px-4 py-3 text-[12px] leading-5 text-muted">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Guardrails</p>
          <ul className="space-y-1">
            <li>Sees only records you can access; restricted (MNPI) records stay hidden.</li>
            <li>Drafts are claim-checked and never sent automatically.</li>
            <li>Stage changes always need your click.</li>
            <li>Web research: {webResearch ? "on (results are research estimates)" : "not configured"}.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
