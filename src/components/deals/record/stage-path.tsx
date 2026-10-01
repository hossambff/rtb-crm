"use client";
import * as React from "react";
import { Check, CheckCircle2, PauseCircle, XCircle } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { applyDealSignal } from "@/lib/signals/actions";
import { useStageMove, type MovableDeal } from "../stage-move";
import type { Picklist, StageDTO } from "@/lib/deals/types";
import { cn } from "@/lib/utils";
import { useScrollStrip } from "@/components/ui/scroll-strip";

/** CARD-1 stage path: monochrome chevrons, current stage white-filled, click to move (gated). Closed outcomes in a menu. */
export function StagePath({
  deal,
  stages,
  canEdit,
  picklists,
  hiddenFields,
  canCreateContact,
  playbookHints,
  autoMove,
}: {
  deal: MovableDeal;
  stages: StageDTO[];
  canEdit: boolean;
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  hiddenFields: string[];
  canCreateContact: boolean;
  playbookHints?: Record<string, { title: string; dueInDays: number }>;
  /**
   * CR M9 (from Today / signals): `?move=<stageId>[&signal=<signalId>]` opens the gate dialog for that stage on mount,
   * prefilled from the playbook; after a successful move the signal is marked applied. The params are stripped so a
   * refresh doesn't reopen the dialog.
   */
  autoMove?: { stageId: string; signalId: string | null } | null;
}) {
  const router = useRouter();
  const [optimisticStage, setOptimisticStage] = React.useOptimistic(deal.stageId);
  const signalRef = React.useRef<string | null>(autoMove?.signalId ?? null);
  const { request, dialog, pending } = useStageMove({
    picklists,
    hiddenFields,
    canCreateContact,
    playbookHints,
    onOptimistic: (_id, stageId) => setOptimisticStage(stageId),
    onMoved: (dealId) => {
      const sig = signalRef.current;
      signalRef.current = null;
      if (!sig) return;
      void applyDealSignal({ id: sig, dealId }).then((r) => {
        if (!r.ok) toast.error(r.error);
        router.refresh();
      });
    },
  });
  const autoRan = React.useRef(false);
  React.useEffect(() => {
    if (autoRan.current || !autoMove || !canEdit) return;
    autoRan.current = true;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("move");
      url.searchParams.delete("signal");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* non-critical */
    }
    const target = stages.find((st) => st.id === autoMove.stageId);
    if (target && target.id !== deal.stageId) request(deal, target);
  }, [autoMove, canEdit, stages, deal, request]);
  const current = stages.find((s) => s.id === optimisticStage);
  // Main path = open stages that aren't parking lots (Cold) + won stages; lost/hold via the outcome menu.
  const path = stages.filter((s) => s.category === "open" || s.category === "won");
  const currentIdx = path.findIndex((s) => s.id === optimisticStage);
  const outcomes = stages.filter((s) => s.category === "lost" || s.category === "hold");
  // Keeps the current stage visible when the path overflows (375px) + hidden scrollbar with an edge-fade hint.
  const listRef = useScrollStrip<HTMLOListElement>(optimisticStage);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ol ref={listRef} className="scrollbar-none scroll-fade-x relative flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain" aria-label="Stage path">
        {path.map((s, i) => {
          const isCurrent = s.id === optimisticStage;
          const done = currentIdx >= 0 && i < currentIdx;
          return (
            <li key={s.id} className="min-w-0 shrink-0">
              <button
                type="button"
                disabled={!canEdit || isCurrent || pending}
                onClick={() => request({ ...deal, stageId: optimisticStage }, s)}
                aria-current={isCurrent ? "step" : undefined}
                title={`${s.name} · ${Math.round(s.probability * 100)}%${s.requiredFields.length ? ` · requires ${s.requiredFields.map(fieldLabel).join(", ")}` : ""}`}
                className={cn(
                  "relative flex h-8 items-center gap-1 whitespace-nowrap pl-5 pr-3 text-[12px] font-medium transition-colors duration-150 [clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%,10px_50%)] first:pl-3 first:[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%)]",
                  isCurrent ? "bg-white text-black" : done ? "bg-surface-3 text-body" : "bg-surface-2 text-muted",
                  canEdit && !isCurrent ? "hover:bg-border-strong hover:text-fg" : "",
                  "disabled:cursor-default",
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : null}
                {s.category === "won" ? <CheckCircle2 className="size-3" aria-hidden /> : null}
                {s.name}
              </button>
            </li>
          );
        })}
      </ol>
      {current && current.category !== "open" && current.category !== "won" ? (
        <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12px] font-medium text-black">
          {current.category === "lost" ? <XCircle className="size-3.5" /> : <PauseCircle className="size-3.5" />} {current.name}
        </span>
      ) : null}
      {canEdit && outcomes.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" disabled={pending}>
              Close or pause…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {path
              .filter((s) => s.category === "won")
              .map((s) => (
                <DropdownMenuItem key={s.id} disabled={s.id === optimisticStage} onSelect={() => request({ ...deal, stageId: optimisticStage }, s)}>
                  <CheckCircle2 className="text-good" /> Won — {s.name}
                </DropdownMenuItem>
              ))}
            {outcomes.map((s) => (
              <DropdownMenuItem key={s.id} disabled={s.id === optimisticStage} onSelect={() => request({ ...deal, stageId: optimisticStage }, s)}>
                {s.category === "lost" ? <XCircle className="text-critical" /> : <PauseCircle className="text-warning" />} {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {dialog}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  muu: "MUU",
  primaryContactId: "primary contact",
  revSharePct: "revenue share",
  contractValueCents: "contract value",
  expectedCloseDate: "close date",
  nextStep: "next step",
};
function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").toLowerCase();
}
