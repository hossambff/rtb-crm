"use client";
import { useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { openCopilot } from "@/components/shell/copilot-launcher";
import { ModKey } from "@/components/ui/mod-key";

/**
 * Copilot front door on My Day (V2 §B7): type a question (or pick a suggestion) → the Copilot side panel opens and asks
 * it. ⌘J opens the same panel from anywhere.
 */
export function AskBar({ children }: { children?: React.ReactNode }) {
  const [q, setQ] = useState("");
  const ask = (text: string) => {
    const t = text.trim();
    openCopilot(t || undefined);
    setQ("");
  };
  return (
    <section aria-label="Ask Copilot" className="rounded-lg border border-border bg-surface-1 px-3 py-3 sm:px-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <Sparkles className="size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
        <label htmlFor="ask-anything" className="sr-only">
          Ask Copilot anything
        </label>
        <input
          id="ask-anything"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={2000}
          autoComplete="off"
          placeholder="Ask anything about your deals, inbox or calls…"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm text-body placeholder:text-muted focus-visible:outline-none"
        />
        <kbd className="hidden rounded border border-border-strong px-1.5 text-[10px] text-muted md:inline" title="Open Copilot from anywhere">
          <ModKey then="J" />
        </kbd>
        <button
          type="submit"
          aria-label="Ask"
          className="touch-target inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-inverse transition-colors duration-150 hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-40"
          disabled={!q.trim()}
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
      {children}
    </section>
  );
}

/** Suggested questions under the Ask bar (streamed in once My Day's data is ready). */
export function SuggestionChips({ suggestions }: { suggestions: string[] }) {
  if (!suggestions.length) return null;
  return (
    <ul className="mt-2.5 flex flex-wrap gap-1.5 pl-6" aria-label="Suggested questions">
      {suggestions.map((s) => (
        <li key={s}>
          <button
            type="button"
            onClick={() => openCopilot(s)}
            className="touch-target rounded-full border border-border px-2.5 py-1 text-xs text-secondary transition-colors duration-150 hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );
}
