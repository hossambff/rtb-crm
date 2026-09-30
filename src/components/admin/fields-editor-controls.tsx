"use client";
/** Small shared form controls for the admin config editors (chip multi-select, list suggestions, number parsing). */
import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChipOption = { value: string; label: string; color?: string };

/** Multi-select as a group of toggle chips (aria-pressed). */
export function ChipMultiSelect({
  labelId,
  options,
  value,
  onChange,
  disabled,
  emptyText = "No options available",
}: {
  labelId: string;
  options: ChipOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
}) {
  if (!options.length) return <p className="text-xs text-muted">{emptyText}</p>;
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors duration-150 disabled:opacity-40",
              on ? "border-white/70 bg-surface-3 text-fg" : "border-border text-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {o.color ? <span aria-hidden className="inline-block h-3 w-1 rounded-full" style={{ background: o.color }} /> : null}
            {on ? <Check aria-hidden className="size-3" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Clickable suggestions that append to a comma-separated text value. */
export function ListSuggestions({ text, suggestions, onChange, label }: { text: string; suggestions: string[]; onChange: (t: string) => void; label: string }) {
  const current = text
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const remaining = suggestions.filter((s) => !current.includes(s.toLowerCase()));
  if (!remaining.length) return null;
  return (
    <div className="flex flex-wrap gap-1" aria-label={`${label} suggestions`}>
      {remaining.slice(0, 24).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(current.length ? `${text.replace(/[,\s]+$/, "")}, ${s}` : s)}
          className="rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-150 hover:border-border-strong hover:text-fg"
        >
          + {s}
        </button>
      ))}
    </div>
  );
}

/** "" → null; otherwise Number (NaN is left for zod to reject with a friendly message). */
export function numOrNull(v: string): number | null {
  return v.trim() === "" ? null : Number(v);
}
/** Percent input string (0..100) → fraction (0..1) or null. */
export function pctOrNull(v: string): number | null {
  return v.trim() === "" ? null : Number(v) / 100;
}
/** Fraction → percent string for inputs (trims float noise). */
export function toPctStr(v: number | null | undefined): string {
  return v == null ? "" : String(Math.round(v * 10000) / 100);
}
