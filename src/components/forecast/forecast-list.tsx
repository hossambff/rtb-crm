"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CheckCheck, ChevronDown, Info, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorTick } from "@/components/ui/badge";
import { EmptyState, Tooltip } from "@/components/ui/misc";
import { confirmForecast } from "@/lib/forecast/actions";
import { CATEGORIES, CATEGORY_LABELS, overrideNeedsReason, quarterLabel, type ForecastCategory } from "@/lib/forecast/core";
import type { ForecastDeal } from "@/lib/forecast/service";
import { fmtUsd } from "@/lib/format";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";

const SHORT: Record<ForecastCategory, string> = { commit: "Commit", best: "Best", pipeline: "Pipeline", omitted: "Omit" };
const KEY: Record<ForecastCategory, string> = { commit: "1", best: "2", pipeline: "3", omitted: "4" };

type Choice = { category: ForecastCategory; note: string };

/**
 * The rep's forecast list. "pending" = deals that need a call this week (never confirmed, or the suggestion disagrees
 * with the last call): each row starts on the suggestion; one click confirms everything, any row can be overridden
 * (a reason is required into / out of Commit). Keyboard: j/k move · 1–4 pick · Enter confirm row · ⇧Enter confirm all.
 */
export function ForecastList({ deals, mode, emptyHint }: { deals: ForecastDeal[]; mode: "pending" | "all"; emptyHint?: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [choices, setChoices] = React.useState<Record<string, Choice>>({});
  const [active, setActive] = React.useState(0);
  const [done, setDone] = React.useState<Set<string>>(new Set());
  const rowsRef = React.useRef<(HTMLLIElement | null)[]>([]);
  const visible = deals.filter((d) => !done.has(d.dealId));
  const editable = visible.filter((d) => d.canEdit);

  const choiceOf = (d: ForecastDeal): Choice => choices[d.dealId] ?? { category: mode === "pending" ? d.suggested : d.effective, note: "" };
  const reasonMissing = (d: ForecastDeal) => {
    const c = choiceOf(d);
    return overrideNeedsReason({ chosen: c.category, suggested: d.suggested, previous: d.lastConfirmed }) && c.note.trim().length < 5;
  };
  const setChoice = (d: ForecastDeal, patch: Partial<Choice>) => setChoices((m) => ({ ...m, [d.dealId]: { ...choiceOf(d), ...patch } }));

  const submit = React.useCallback(
    (rows: ForecastDeal[]) => {
      const items = rows.filter((d) => d.canEdit).map((d) => ({ dealId: d.dealId, category: choiceOf(d).category, note: choiceOf(d).note.trim() || undefined }));
      if (!items.length) return;
      const missing = rows.find((d) => d.canEdit && reasonMissing(d));
      if (missing) {
        toast.error(`Add a reason for ${missing.name}`, { description: "Moving a deal into or out of Commit against the suggestion needs a short why." });
        return;
      }
      startTransition(async () => {
        const r = await confirmForecast({ items });
        if (!r.ok) return void toast.error(r.error);
        const ok = new Set(items.map((i) => i.dealId).filter((id) => !r.data.skipped.some((s) => s.dealId === id)));
        setDone((prev) => new Set([...prev, ...ok]));
        if (r.data.skipped.length) toast.warning(`${r.data.confirmed} confirmed · ${r.data.skipped.length} skipped`, { description: r.data.skipped.slice(0, 3).map((s) => s.reason).join("\n") });
        else toast.success(r.data.confirmed === 1 ? "Forecast call saved" : `Forecast confirmed for ${r.data.confirmed} deals`, { description: r.data.overridden ? `${r.data.overridden} override${r.data.overridden === 1 ? "" : "s"} recorded with your reasons` : undefined });
        router.refresh();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, router],
  );

  // Keyboard shortcuts (ignored while typing in an input).
  React.useEffect(() => {
    if (mode !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // QA MIN-31: only typing targets swallow shortcuts (a clicked pill keeps focus but j/k/1–4 must still work);
      // Enter on a focused button/link keeps its native meaning.
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      if (t && e.key === "Enter" && ["BUTTON", "A"].includes(t.tagName)) return;
      if (document.querySelector('[role="dialog"]')) return; // ⌘K or another dialog is open
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const d = visible[active];
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (d && d.canEdit && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        setChoice(d, { category: CATEGORIES[Number(e.key) - 1]! });
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        submit(editable);
      } else if (e.key === "Enter" && d) {
        e.preventDefault();
        submit([d]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  React.useEffect(() => {
    rowsRef.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!visible.length) {
    return mode === "pending" ? (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface-1 px-6 py-12 text-center">
        <span className="mb-3 inline-flex size-10 items-center justify-center rounded-full border border-border-strong">
          <Check className="size-5 text-fg" strokeWidth={1.5} />
        </span>
        <p className="font-display text-lg text-fg">Your forecast is in</p>
        <p className="mt-1 max-w-sm text-sm text-muted">{emptyHint ?? "Every deal has your call for this week. New suggestions show up here when something changes."}</p>
      </div>
    ) : (
      <EmptyState title="No deals in the forecast window" description={emptyHint ?? "Open deals with an expected close this quarter or next appear here."} />
    );
  }

  const overrides = editable.filter((d) => choiceOf(d).category !== d.suggested).length;
  return (
    <div className="space-y-2">
      {mode === "pending" && editable.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={pending} onClick={() => submit(editable)}>
            {pending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            {overrides ? `Confirm ${editable.length} (${overrides} changed)` : `Confirm all ${editable.length}`}
          </Button>
          <p className="hidden text-[11px] text-muted md:block">
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>1</Kbd>–<Kbd>4</Kbd> pick · <Kbd>Enter</Kbd> confirm row · <Kbd>⇧</Kbd>
            <Kbd>Enter</Kbd> confirm all
          </p>
        </div>
      ) : null}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-1" role="list">
        {visible.map((d, i) => {
          const c = choiceOf(d);
          const needReason = overrideNeedsReason({ chosen: c.category, suggested: d.suggested, previous: d.lastConfirmed });
          const isActive = mode === "pending" && i === active;
          return (
            <li
              key={d.dealId}
              ref={(el) => {
                rowsRef.current[i] = el;
              }}
              onClick={() => setActive(i)}
              className={cn("px-3 py-2.5 transition-colors duration-150 md:px-4", isActive ? "bg-surface-2" : "")}
              aria-current={isActive ? "true" : undefined}
            >
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ColorTick color={d.pipelineColor} />
                    <Link href={`/deals/${d.dealId}`} className="truncate text-sm font-medium text-fg hover:underline">
                      {d.name}
                    </Link>
                    {d.restricted ? <Lock className="size-3 shrink-0 text-secondary" aria-label="Restricted" /> : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted">
                    {[d.pipelineKey, d.stageName, d.ownerName, `closes ${formatInTz(d.closeDate, "UTC", "short")}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="text-right tabular">
                  <p className="text-sm text-fg">{d.unit === "activation" ? "—" : fmtUsd(d.weightedUsd, { compact: true })}</p>
                  <p className="text-[11px] text-muted">{d.unit === "activation" ? "activation" : `of ${fmtUsd(d.grossUsd, { compact: true })} · ${Math.round(d.probability * 100)}%`}</p>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Segmented value={c.category} suggested={d.suggested} disabled={!d.canEdit || pending} onChange={(v) => setChoice(d, { category: v })} label={`Forecast category for ${d.name}`} />
                  {mode === "pending" && d.canEdit ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`Confirm ${d.name}`} disabled={pending || (needReason && c.note.trim().length < 5)} onClick={() => submit([d])}>
                      <Check />
                    </Button>
                  ) : null}
                  {mode === "all" && d.canEdit && c.category !== d.effective ? (
                    <Button size="sm" variant="secondary" className="h-7" disabled={pending || (needReason && c.note.trim().length < 5)} onClick={() => submit([d])}>
                      Save
                    </Button>
                  ) : null}
                </div>
              </div>
              <Reasons d={d} />
              {needReason && d.canEdit && (mode === "pending" || c.category !== d.effective) ? (
                <div className="mt-2">
                  <label className="sr-only" htmlFor={`why-${d.dealId}`}>
                    Reason for {CATEGORY_LABELS[c.category]}
                  </label>
                  <Input
                    id={`why-${d.dealId}`}
                    value={c.note}
                    maxLength={500}
                    onChange={(e) => setChoice(d, { note: e.target.value })}
                    placeholder={c.category === "commit" ? "Why is this Commit? e.g. verbal yes from the CRO, paper in legal" : "Why out of Commit? e.g. budget moved to January"}
                    className={cn("h-8 text-xs", c.note.trim().length < 5 ? "border-border-strong" : "")}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Reasons({ d }: { d: ForecastDeal }) {
  const [open, setOpen] = React.useState(false);
  const status =
    d.state === "confirmed"
      ? `${d.confirmedByName ? `Set by ${d.confirmedByName}: ${CATEGORY_LABELS[d.effective]}` : `You called it ${CATEGORY_LABELS[d.effective]}`} this week${d.note ? ` — “${d.note}”` : ""}`
      : d.lastConfirmed
        ? `Last call: ${CATEGORY_LABELS[d.lastConfirmed]}${d.lastConfirmedWeek ? ` (week of ${formatInTz(`${d.lastConfirmedWeek}T12:00:00Z`, "UTC", "short")})` : ""}`
        : "Not confirmed yet";
  const headline = d.headline;
  return (
    <div className="mt-1.5 text-[11px] leading-4 text-muted">
      <button type="button" className="inline-flex max-w-full items-start gap-1 text-left hover:text-secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Info className="mt-px size-3 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="text-secondary">Suggested {CATEGORY_LABELS[d.suggested]}</span>
          {headline ? <span> · {headline}</span> : null}
          <span> · {status}</span>
        </span>
        <ChevronDown className={cn("mt-px size-3 shrink-0 transition-transform duration-150", open ? "rotate-180" : "")} aria-hidden />
      </button>
      {open ? (
        <ul className="mt-1 space-y-0.5 border-l border-border pl-3">
          {d.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
          <li>
            {quarterLabel(d.period)} · {d.engine === "stage" ? "stage probability only (suggestions off)" : "autopilot (rules) suggestion"} · weighted gross{d.overridden ? " · includes an approved probability override" : ""}
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function Segmented({ value, suggested, onChange, disabled, label }: { value: ForecastCategory; suggested: ForecastCategory; onChange: (v: ForecastCategory) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border-strong p-0.5">
      {CATEGORIES.map((c) => (
        <Tooltip key={c} content={`${CATEGORY_LABELS[c]}${c === suggested ? " (suggested)" : ""} · key ${KEY[c]}`}>
          <button
            type="button"
            role="radio"
            aria-checked={value === c}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onChange(c);
            }}
            className={cn(
              "relative h-7 rounded px-2 text-[11px] font-medium transition-colors duration-150 disabled:opacity-50",
              value === c ? "bg-accent text-accent-inverse" : "text-secondary hover:bg-surface-3 hover:text-fg",
            )}
          >
            {SHORT[c]}
            {c === suggested && value !== c ? <span aria-hidden className="absolute right-0.5 top-0.5 size-1 rounded-full bg-white/70" /> : null}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border-strong px-1 text-[10px] text-secondary">{children}</kbd>;
}
