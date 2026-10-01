"use client";
import { Loader2, Sparkles, Undo2 } from "lucide-react";
import { PopoverContent, Popover, PopoverTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { undoAutofill } from "@/lib/deals/actions";
import type { AutofillEntry, AutofillField } from "@/lib/deals/create-core";
import { useRun } from "./use-run";

/** Subtle "auto" chip next to a field the system filled at creation (V2 §B4): why + one-click undo. */
export function AutoMarker({ dealId, field, entry, canEdit }: { dealId: string; field: AutofillField; entry: AutofillEntry | undefined; canEdit: boolean }) {
  const [run, pending] = useRun();
  if (!entry) return null;
  const engine = entry.engine.startsWith("ai:") ? "Copilot" : "rule";
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-4 items-center gap-0.5 rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted transition-colors duration-150 hover:border-border-strong hover:text-fg"
        aria-label={`Auto-filled: ${entry.reason}`}
      >
        <Sparkles className="size-2.5" aria-hidden /> auto
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <p className="text-[12px] text-body">
          Auto-filled ({engine}): <span className="text-fg">{entry.label}</span>
        </p>
        {entry.reason ? <p className="mt-1 text-[11px] text-muted">{entry.reason}</p> : null}
        {canEdit ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2.5 w-full"
            disabled={pending}
            onClick={() => run(() => undoAutofill({ dealId, field }), { success: (d) => (d.cleared ? "Auto-fill undone" : "Marked as set by hand") })}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
