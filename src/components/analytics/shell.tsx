"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ScrollStrip } from "@/components/ui/scroll-strip";
import { FilterSheet } from "@/components/ui/filter-sheet";
import { RANGE_LABELS, RANGE_PRESETS } from "@/lib/analytics/filters";

export type AnalyticsTab = { href: string; label: string };
type Option = { value: string; label: string };

const PendingContext = React.createContext(false);

/**
 * Analytics frame: tabs + ONE filter row above every chart (dataviz rule: filters scope everything below them).
 * Filters live in the URL; while a new slice loads, the previous render is held at reduced opacity (no skeleton flash).
 */
export function AnalyticsShell({
  tabs,
  pipelines,
  owners,
  netAllowed,
  children,
}: {
  tabs: AnalyticsTab[];
  pipelines: Option[];
  owners: Option[];
  netAllowed: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false }));
  };
  const qs = params.toString();
  const range = params.get("range") ?? "30d";
  const basis = params.get("basis") === "net" && netAllowed ? "net" : "gross";
  const overrides = params.get("overrides") === "excl" ? "excl" : "incl";
  const SECONDARY = ["pipeline", "owner", "basis", "overrides"] as const;
  const secondaryCount = SECONDARY.filter((k) => params.get(k)).length;
  const clearSecondary = () => {
    const next = new URLSearchParams(params.toString());
    SECONDARY.forEach((k) => next.delete(k));
    const q = next.toString();
    startTransition(() => router.replace(`${pathname}${q ? `?${q}` : ""}`, { scroll: false }));
  };

  return (
    <PendingContext.Provider value={pending}>
      <ScrollStrip as="nav" activeKey={pathname} aria-label="Dashboards" className="-mx-4 mb-4 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0">
        <ul className="flex min-w-max gap-1 shadow-[inset_0_-1px_0_var(--border)]">
          {tabs.map((t) => {
            const active = t.href === "/analytics" ? pathname === "/analytics" : pathname.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link
                  href={`${t.href}${qs ? `?${qs}` : ""}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "touch-target flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150",
                    active ? "border-white text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </ScrollStrip>

      <div role="group" aria-label="Filters" className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented
          label="Date range"
          value={range}
          options={RANGE_PRESETS.map((r) => ({ value: r, label: r === "ytd" ? "YTD" : r.replace("d", "D") }))}
          titles={RANGE_LABELS}
          onChange={(v) => set("range", v === "30d" ? null : v)}
        />
        {/* Phones: range stays visible; the rest collapse into a bottom sheet. */}
        <FilterSheet count={secondaryCount} onClear={clearSecondary}>
        <FilterSelect label="Pipeline" value={params.get("pipeline") ?? ""} options={[{ value: "", label: "All pipelines" }, ...pipelines]} onChange={(v) => set("pipeline", v || null)} />
        {owners.length ? (
          <FilterSelect label="Owner" value={params.get("owner") ?? ""} options={[{ value: "", label: "All owners" }, ...owners]} onChange={(v) => set("owner", v || null)} />
        ) : null}
        <span className="mx-1 hidden h-5 w-px bg-border md:block" aria-hidden />
        {netAllowed ? (
          <Segmented
            label="Money basis"
            value={basis}
            options={[
              { value: "gross", label: "Gross" },
              { value: "net", label: "RTB net" },
            ]}
            onChange={(v) => set("basis", v === "gross" ? null : v)}
          />
        ) : (
          <span className="rounded-md border border-border px-2 py-1 text-xs text-muted">Gross basis</span>
        )}
        <Segmented
          label="Manual probability overrides"
          value={overrides}
          options={[
            { value: "incl", label: "Incl. overrides" },
            { value: "excl", label: "Excl. overrides" },
          ]}
          onChange={(v) => set("overrides", v === "incl" ? null : v)}
        />
        </FilterSheet>
        {pending ? <span className="text-xs text-muted" aria-live="polite">Updating…</span> : null}
      </div>
      <PendingFrame>{children}</PendingFrame>
    </PendingContext.Provider>
  );
}

function PendingFrame({ children }: { children: React.ReactNode }) {
  const pending = React.useContext(PendingContext);
  return (
    <div className={cn("transition-opacity duration-150", pending && "pointer-events-none opacity-50")} aria-busy={pending}>
      {children}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  titles,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  titles?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-surface-1 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={titles?.[o.value]}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              "h-7 rounded px-2.5 text-xs font-medium transition-colors duration-150 pointer-coarse:h-9",
              active ? "bg-white text-black" : "text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const id = React.useId();
  return (
    <div className="inline-flex items-center">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="touch-target h-8 max-w-48 rounded-md border border-border bg-surface-1 px-2 text-xs text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
