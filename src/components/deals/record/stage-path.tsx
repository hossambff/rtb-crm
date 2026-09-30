"use client";
import * as React from "react";
import { Check, CheckCircle2, PauseCircle, XCircle } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { useStageMove, type MovableDeal } from "../stage-move";
import type { Picklist, StageDTO } from "@/lib/deals/types";
import { cn } from "@/lib/utils";

/** CARD-1 stage path: monochrome chevrons, current stage white-filled, click to move (gated). Closed outcomes in a menu. */
export function StagePath({
  deal,
  stages,
  canEdit,
  picklists,
  hiddenFields,
  canCreateContact,
}: {
  deal: MovableDeal;
  stages: StageDTO[];
  canEdit: boolean;
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  hiddenFields: string[];
  canCreateContact: boolean;
}) {
  const [optimisticStage, setOptimisticStage] = React.useOptimistic(deal.stageId);
  const { request, dialog, pending } = useStageMove({ picklists, hiddenFields, canCreateContact, onOptimistic: (_id, stageId) => setOptimisticStage(stageId) });
  const current = stages.find((s) => s.id === optimisticStage);
  // Main path = open stages that aren't parking lots (Cold) + won stages; lost/hold via the outcome menu.
  const path = stages.filter((s) => s.category === "open" || s.category === "won");
  const currentIdx = path.findIndex((s) => s.id === optimisticStage);
  const outcomes = stages.filter((s) => s.category === "lost" || s.category === "hold");
  const listRef = React.useRef<HTMLOListElement>(null);
  React.useEffect(() => {
    // keep the current stage visible when the path overflows (375px)
    const el = listRef.current?.querySelector<HTMLElement>('[aria-current="step"]');
    const list = listRef.current;
    if (el && list && list.scrollWidth > list.clientWidth) list.scrollLeft = el.offsetLeft - list.clientWidth / 2 + el.clientWidth / 2;
  }, [optimisticStage]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ol ref={listRef} className="relative flex min-w-0 flex-1 overflow-x-auto" aria-label="Stage path">
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
                title={`${s.name} · ${Math.round(s.probability * 100)}%${s.requiredFields.length ? ` · requires ${s.requiredFields.join(", ")}` : ""}`}
                className={cn(
                  "relative flex h-8 items-center gap-1 whitespace-nowrap pl-5 pr-3 text-[12px] font-medium transition-colors duration-150 [clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%,10px_50%)] first:pl-3 first:[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%)]",
                  isCurrent ? "bg-white text-black" : done ? "bg-surface-3 text-body" : "bg-surface-2 text-muted",
                  canEdit && !isCurrent ? "hover:bg-[#3c3c3c] hover:text-fg" : "",
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
              Close / hold…
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
