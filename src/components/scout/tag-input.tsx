"use client";
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Chip input: Enter/comma adds, Backspace on empty removes last. Optional suggestions (datalist). */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
  suggestions,
  transform,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  transform?: (s: string) => string | null;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const listId = React.useId();
  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    const next = [...value];
    for (const p of parts) {
      const t = transform ? transform(p) : p;
      if (t && !next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    }
    onChange(next);
    setDraft("");
  };
  return (
    <div className={cn("flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-surface-3/40 px-2 py-1 focus-within:ring-2 focus-within:ring-white/80", className)}>
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 text-xs text-body">
          {v}
          <button type="button" aria-label={`Remove ${v}`} className="text-muted hover:text-fg" onClick={() => onChange(value.filter((x) => x !== v))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        list={suggestions?.length ? listId : undefined}
        className="h-7 min-w-24 flex-1 bg-transparent text-sm text-body placeholder:text-muted focus:outline-none"
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\n]$/.test(v)) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            add(t);
          }
        }}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
