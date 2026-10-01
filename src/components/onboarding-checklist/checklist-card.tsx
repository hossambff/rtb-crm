"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openCopilot } from "@/components/shell/copilot-launcher";
import { setChecklistDismissed } from "@/lib/prefs/actions";
import type { ChecklistStep } from "@/lib/prefs/checklist-core";

/** Thin progress ring (white on hairline) — the only "chart" on the card, so it stays monochrome. */
export function ProgressRing({ done, total, size = 40 }: { done: number; total: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${done} of ${total} done`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-border)" strokeWidth="2" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--color-fg)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        className="transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
      />
    </svg>
  );
}

/**
 * First-run checklist (V2 §B9): role-aware steps whose completion is detected from real state; dismissible.
 * `variant="settings"` renders without the dismiss control (Settings shows it to bring it back).
 */
export function ChecklistCard({
  steps,
  done,
  total,
  variant = "home",
  resumeHref = null,
  wizardStarted = false,
}: {
  steps: ChecklistStep[];
  done: number;
  total: number;
  variant?: "home" | "settings";
  /** First open step's /welcome deep link — "Resume setup" (unified with the team onboarding wizard). */
  resumeHref?: string | null;
  wizardStarted?: boolean;
}) {
  const [hidden, setHidden] = useState(false);
  const [pending, start] = useTransition();
  if (hidden) return null;
  const next = steps.find((s) => !s.done);
  return (
    <section aria-labelledby="checklist-title" className="rounded-lg border border-border bg-surface-1">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <ProgressRing done={done} total={total} />
        <div className="min-w-[9rem] flex-1">
          <h2 id="checklist-title" className="font-display text-lg leading-6 text-fg">
            Get set up
          </h2>
          <p className="text-xs text-muted">
            {done} of {total} done{next ? ` · next: ${next.title.toLowerCase()}` : " · all set"}
          </p>
        </div>
        {resumeHref ? (
          <Button asChild size="sm" variant="primary">
            <Link href={resumeHref}>{wizardStarted ? "Resume setup" : "Start setup"}</Link>
          </Button>
        ) : null}
        {variant === "home" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide the setup checklist"
            title="Hide (you can bring it back in Settings)"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setHidden(true);
                const r = await setChecklistDismissed({ dismissed: true });
                if (!r.ok) {
                  setHidden(false);
                  toast.error(r.error);
                } else toast.success("Checklist hidden — bring it back any time in Settings.");
              })
            }
          >
            <X />
          </Button>
        ) : null}
      </div>
      <ol className="divide-y divide-border">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                s.done ? "border-fg bg-fg text-accent-inverse" : "border-border-strong",
              )}
            >
              {s.done ? <Check className="size-3" strokeWidth={2.5} /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", s.done ? "text-muted line-through decoration-border-strong" : "text-fg")}>
                {s.title}
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </p>
              {!s.done ? (
                <p className="text-[11px] text-muted">
                  {s.skipped ? <span className="text-secondary">Skipped · </span> : null}
                  {s.why}
                </p>
              ) : null}
            </div>
            {!s.done ? (
              s.id === "copilot" ? (
                <Button size="sm" variant={s === next && !resumeHref ? "primary" : "secondary"} onClick={() => openCopilot("Which of my deals have no next step?")}>
                  {s.cta}
                </Button>
              ) : (
                <Button asChild size="sm" variant={s === next && !resumeHref ? "primary" : "secondary"}>
                  <Link href={s.href}>{s.cta}</Link>
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Settings: bring a dismissed checklist back to My Day. */
export function ChecklistRestoreButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await setChecklistDismissed({ dismissed: false });
          if (!r.ok) toast.error(r.error);
          else toast.success("The checklist is back on My Day.");
        })
      }
    >
      Show on My Day
    </Button>
  );
}
