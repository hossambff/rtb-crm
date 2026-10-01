"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { undoCallAutopilot } from "@/lib/transcripts/actions";

export type AutopilotView = {
  status: "applied" | "skipped" | "undone";
  reason?: string | null;
  at: string;
  tasks: number;
  nextStep: string | null;
  undoUntil: string | null; // ISO when undo is still possible
};

const SKIP_REASONS: Record<string, string> = {
  untrusted: "The transcript contained instruction-like text, so nothing was applied automatically.",
  no_access: "You can't edit the linked deal, so nothing was applied automatically.",
};

/** V2 A1: what the post-call autopilot did on this call, with a 24-hour undo. */
export function AutopilotBanner({ id, view, canUndo }: { id: string; view: AutopilotView; canUndo: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const undo = () =>
    start(async () => {
      const r = await undoCallAutopilot({ id });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Undone: ${r.data.tasks} task${r.data.tasks === 1 ? "" : "s"} cancelled${r.data.nextStepRestored ? ", next step restored" : ""}${r.data.draftRemoved ? ", Gmail draft removed" : ""}.`);
      router.refresh();
    });

  return (
    <div role="status" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-border-strong">
          <Sparkles className="size-3.5 text-fg" aria-hidden />
        </span>
        <div className="min-w-0 text-sm">
          {view.status === "applied" ? (
            <>
              <p className="text-fg">
                Autopilot applied{" "}
                <span className="tabular">{view.tasks}</span> task{view.tasks === 1 ? "" : "s"}
                {view.nextStep ? " and set the next step" : ""} <span className="text-muted">· <RelativeTime value={view.at} /></span>
              </p>
              {view.nextStep ? <p className="truncate text-xs text-secondary">Next step: {view.nextStep}</p> : null}
              <p className="text-xs text-muted">Stage changes are suggested as signals on the deal — never moved automatically.</p>
            </>
          ) : view.status === "undone" ? (
            <p className="text-secondary">Autopilot changes on this call were undone.</p>
          ) : (
            <p className="text-secondary">{SKIP_REASONS[view.reason ?? ""] ?? "Autopilot didn't apply anything on this call."} Review the items below.</p>
          )}
        </div>
      </div>
      {view.status === "applied" && view.undoUntil && canUndo ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={undo} className="self-start sm:self-center">
          <Undo2 /> {pending ? "Undoing…" : "Undo"}
        </Button>
      ) : null}
    </div>
  );
}
