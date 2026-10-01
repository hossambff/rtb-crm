"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, Minus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deferOnboarding, startOnboarding } from "@/lib/welcome/actions";
import { isRequiredStep, progressSteps, STEP_META, wizardProgress, type OnboardingState, type StepStatus, type WizardStepId } from "@/lib/welcome/core";
import type { WizardData } from "@/lib/welcome/queries";
import { STEP_FORM_ID } from "./bits";
import { BookStep, DoneStep, ProfileStep, SellStep, TargetsStep, ToolsStep, WelcomeStep, WorkStep } from "./steps";

/**
 * Team onboarding wizard (/welcome). Steps are role-aware (server decides which apply), state is saved per step in
 * user_prefs.onboarding so people can skip, leave ("Finish later") and resume from a deep link (?step=tools).
 * Keyboard: ⌘/Ctrl+Enter continues, Alt+← goes back; the rail is a list of buttons.
 */
export function WelcomeWizard({ data, initialStep, scopes }: { data: WizardData; initialStep: WizardStepId; scopes: string[] }) {
  const [step, setStep] = useState<WizardStepId>(initialStep);
  const [statuses, setStatuses] = useState<Partial<Record<WizardStepId, StepStatus>>>(() => {
    const out: Partial<Record<WizardStepId, StepStatus>> = {};
    for (const [k, v] of Object.entries(data.onboarding.steps ?? {})) if (v) out[k as WizardStepId] = v.status;
    return out;
  });
  const [leaving, startLeave] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const steps = data.steps;
  const idx = steps.indexOf(step);
  const counted = progressSteps(steps);
  const state: OnboardingState = { steps: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { status: v!, at: "" }])) };
  const progress = wizardProgress(state, steps);

  // First visit: stamp startedAt (stops the first-run redirect). Fire and forget.
  useEffect(() => {
    if (!data.onboarding.startedAt) void startOnboarding({});
  }, [data.onboarding.startedAt]);

  const go = useCallback((next: WizardStepId) => {
    setStep(next);
    window.history.replaceState(null, "", `/welcome?step=${next}`);
  }, []);

  // Move focus to the new step's heading (screen readers announce it; keyboard users continue from the top).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [step]);

  const back = idx > 0 ? () => go(steps[idx - 1]!) : undefined;
  const backRef = useRef(back);
  useEffect(() => {
    backRef.current = back;
  });
  const complete = (s: WizardStepId) => (status: StepStatus) => {
    setStatuses((p) => ({ ...p, [s]: status }));
    const next = steps[steps.indexOf(s) + 1];
    if (next) go(next);
  };

  // ⌘/Ctrl+Enter = Continue (submit the step's form); Alt+← = Back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const form = document.getElementById(STEP_FORM_ID) as HTMLFormElement | null;
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      } else if (e.key === "ArrowLeft" && e.altKey && backRef.current) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // Alt+← moves by word in fields
        e.preventDefault();
        backRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const finishLater = () =>
    startLeave(async () => {
      const r = await deferOnboarding({});
      if (!r.ok) return void toast.error(r.error);
      toast.success("Saved. The rest waits on your My Day checklist.");
      window.location.assign(r.data.redirect);
    });

  const meta = STEP_META[step];
  const position = counted.indexOf(step);
  const props = { onBack: back, onComplete: complete(step), status: statuses[step] ?? null };

  let body: React.ReactNode;
  switch (step) {
    case "welcome":
      body = <WelcomeStep {...props} who={data.who} />;
      break;
    case "profile":
      body = <ProfileStep {...props} profile={data.profile} zones={data.zones} />;
      break;
    case "sell":
      body = <SellStep {...props} sell={data.sell} />;
      break;
    case "book":
      body = <BookStep {...props} book={data.book} />;
      break;
    case "targets":
      body = <TargetsStep {...props} targets={data.targets} motions={data.sell.motions} />;
      break;
    case "tools":
      body = <ToolsStep {...props} tools={data.tools} scopes={scopes} />;
      break;
    case "work":
      body = <WorkStep {...props} work={data.work} />;
      break;
    case "done":
      body = <DoneStep canCopilot={data.canCopilot} skipped={progress.skipped} missing={progress.missingRequired} onGo={go} onBack={back} />;
      break;
  }

  const first = data.who.name.split(" ")[0];
  return (
    <div className="mx-auto grid w-full max-w-5xl flex-1 gap-8 px-4 py-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-12 md:px-8 md:py-12">
      <style>{`@keyframes rso-step-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      {/* Progress rail: vertical on desktop, a thin segmented bar on phones. */}
      <nav aria-label="Setup steps" className="md:sticky md:top-12 md:self-start">
        <div className="flex items-center justify-between md:hidden">
          <p className="text-xs text-muted tabular">
            {step === "done" ? "All steps" : `Step ${position + 1} of ${counted.length}`} · {progress.done}/{counted.length} done
          </p>
          <Button variant="ghost" size="sm" onClick={finishLater} disabled={leaving}>
            Finish later
          </Button>
        </div>
        <div className="mt-2 flex gap-1 md:hidden" aria-hidden>
          {counted.map((s) => (
            <span
              key={s}
              className={cn(
                "h-0.5 flex-1 rounded-full transition-colors duration-200",
                s === step ? "bg-fg" : statuses[s] === "done" ? "bg-secondary" : statuses[s] === "skipped" ? "bg-border-strong" : "bg-border",
              )}
            />
          ))}
        </div>
        <ol className="hidden space-y-0.5 md:block">
          {steps.map((s, i) => {
            const st = statuses[s];
            const current = s === step;
            return (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => go(s)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                    current ? "text-fg" : "text-muted hover:text-body",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular transition-colors duration-150",
                      st === "done" ? "border-fg bg-fg text-accent-inverse" : current ? "border-fg text-fg" : st === "skipped" ? "border-dashed border-border-strong" : "border-border-strong",
                    )}
                  >
                    {st === "done" ? <Check className="size-3" strokeWidth={2.5} /> : st === "skipped" ? <Minus className="size-3" /> : s === "done" ? null : i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{STEP_META[s].short}</span>
                  <span className="sr-only">{st === "done" ? "(done)" : st === "skipped" ? "(skipped)" : isRequiredStep(s) ? "(required)" : ""}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-6 hidden border-t border-border pt-4 md:block">
          <p className="text-xs text-muted tabular">
            {progress.done} of {counted.length} done
          </p>
          <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={finishLater} disabled={leaving}>
            Finish later
          </Button>
          <p className="mt-3 text-[11px] leading-4 text-muted">
            <kbd className="font-sans">Alt ←</kbd> back
          </p>
        </div>
      </nav>

      <section aria-labelledby="welcome-step-title" className="min-w-0">
        <div key={step} className="motion-safe:animate-[rso-step-in_180ms_ease-out]">
          <p className="text-xs uppercase tracking-wide text-muted tabular">
            {step === "done" ? "Ready" : `Step ${position + 1} of ${counted.length}`}
            {isRequiredStep(step) ? " · required" : step === "done" ? "" : " · optional"}
          </p>
          <h1 id="welcome-step-title" ref={headingRef} tabIndex={-1} className="mt-2 font-display text-[32px] font-medium leading-10 text-fg focus:outline-none md:text-[40px] md:leading-[48px]">
            {step === "welcome" ? `Welcome, ${first}.` : step === "done" ? (progress.canFinish ? `You're set, ${first}.` : `Almost there, ${first}.`) : meta.title}
          </h1>
          <p className="mt-1 text-sm text-muted">{step === "welcome" ? "Let's get you organized for the quarter." : meta.blurb}</p>
          <div className="mt-8">{body}</div>
        </div>
      </section>
    </div>
  );
}
