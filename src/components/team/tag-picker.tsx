"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLAYBOOK_TAG_LABELS, PLAYBOOK_TAGS, type PlaybookTag } from "@/lib/team/story-core";

/** Toggle chips for playbook tags (objection / pitch / pricing / coalition). */
export function TagPicker({ value, onChange, label = "Tags" }: { value: PlaybookTag[]; onChange: (v: PlaybookTag[]) => void; label?: string }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-secondary">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {PLAYBOOK_TAGS.map((t) => {
          const on = value.includes(t);
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150",
                on ? "border-white bg-white text-black" : "border-border-strong text-secondary hover:bg-surface-3 hover:text-fg",
              )}
            >
              {on ? <Check className="size-3.5" aria-hidden /> : null}
              {PLAYBOOK_TAG_LABELS[t]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
