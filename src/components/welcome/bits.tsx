"use client";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModKey } from "@/components/ui/mod-key";
import { cn } from "@/lib/utils";

export const STEP_FORM_ID = "welcome-step-form";

/** Toggle chip (multi-select), keyboard reachable, state announced via aria-pressed. */
export function Chip({
  pressed,
  onToggle,
  children,
  className,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "touch-target inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        pressed ? "border-fg bg-fg text-accent-inverse" : "border-border-strong text-body hover:bg-surface-2",
        className,
      )}
    >
      {pressed ? <Check className="size-3.5" strokeWidth={2.5} aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border after:absolute after:-inset-2.5 after:content-[''] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        checked ? "border-fg bg-fg" : "border-border-strong bg-surface-3",
      )}
    >
      <span className={cn("inline-block size-3.5 rounded-full transition-transform duration-150", checked ? "translate-x-[18px] bg-accent-inverse" : "translate-x-[2px] bg-secondary")} />
    </button>
  );
}

/** Segmented single choice: a radio group with arrow-key movement. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-border-strong p-0.5"
      onKeyDown={(e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = options.findIndex((o) => o.value === value);
        const next = options[(i + d + options.length) % options.length]!;
        onChange(next.value);
        (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 rounded px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
            o.value === value ? "bg-fg text-accent-inverse" : "text-secondary hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled block inside a step (hairline separated). */
export function Field({ label, hint, htmlFor, error, children, className }: { label: string; hint?: React.ReactNode; htmlFor?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-xs font-medium text-secondary">
          {label}
        </label>
      ) : (
        <p className="text-xs font-medium text-secondary">{label}</p>
      )}
      {children}
      {error ? (
        <p className="text-xs text-critical" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Step footer: Back · (Skip for now) · Continue. Continue submits the step's form (`STEP_FORM_ID`), so Enter in a field
 * and ⌘/Ctrl+Enter anywhere both advance.
 */
export function StepFooter({
  onBack,
  onSkip,
  continueLabel = "Continue",
  continueDisabled,
  pending,
  required,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  pending?: boolean;
  required?: boolean;
}) {
  return (
    // Phones: the action bar sticks to the bottom so Continue is always reachable on long steps.
    <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border pt-5 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:bg-bg/95 max-md:px-4 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:pt-3 max-md:backdrop-blur-[2px]">
      {onBack ? (
        <Button type="button" variant="ghost" size="md" onClick={onBack} disabled={pending} aria-keyshortcuts="Alt+ArrowLeft">
          <ArrowLeft /> Back
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {required ? <span className="hidden text-xs text-muted sm:inline">Required</span> : null}
        {onSkip ? (
          <Button type="button" variant="ghost" size="md" onClick={onSkip} disabled={pending}>
            Skip for now
          </Button>
        ) : null}
        <Button type="submit" form={STEP_FORM_ID} variant="primary" size="md" disabled={pending || continueDisabled} aria-keyshortcuts="Control+Enter Meta+Enter">
          {pending ? "Saving…" : continueLabel}
          <kbd className="hidden rounded border border-black/20 px-1 font-sans text-[10px] font-medium leading-4 text-accent-inverse/70 md:inline">
            <ModKey then="↵" />
          </kbd>
        </Button>
      </div>
    </div>
  );
}
