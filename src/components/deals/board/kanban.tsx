"use client";
import * as React from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CheckCircle2, Clock, MoreHorizontal, PauseCircle, XCircle } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { PRIORITY_LABELS, type BoardDeal, type Lane, type PipelineDTO, type StageDTO, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";
import { HealthBadge, NextStepLine, OwnerStack, PriorityTag, RestrictedLock, valueLabel } from "../deal-bits";
import { sortCards, type ColumnTotals } from "@/lib/deals/board-shape";

type LaneDef = { key: string; label: string; user?: UserLite; match: (d: BoardDeal) => boolean };

function buildLanes(lane: Lane, deals: BoardDeal[]): LaneDef[] {
  if (lane === "owner") {
    const map = new Map<string, UserLite>();
    for (const d of deals) if (d.ownerId && d.owners[0]) map.set(d.ownerId, d.owners[0]);
    const lanes: LaneDef[] = [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({ key: `o:${u.id}`, label: u.name, user: u, match: (d) => d.ownerId === u.id }));
    if (deals.some((d) => !d.ownerId)) lanes.push({ key: "o:none", label: "Unassigned", match: (d) => !d.ownerId });
    return lanes;
  }
  if (lane === "priority") {
    const lanes: LaneDef[] = (Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map((p) => ({
      key: `p:${p}`,
      label: PRIORITY_LABELS[p],
      match: (d) => d.priority === p,
    }));
    lanes.push({ key: "p:none", label: "No priority", match: (d) => !d.priority });
    return lanes.filter((l) => deals.some(l.match));
  }
  return [{ key: "all", label: "", match: () => true }];
}

/** Prefer the column under the pointer; fall back to rectangle overlap (keyboard drags). */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

export function Kanban({
  pipeline,
  stages,
  deals,
  lane,
  totals,
  onMove,
  onLoadMore,
  loadingStage,
}: {
  pipeline: PipelineDTO;
  stages: StageDTO[];
  deals: BoardDeal[];
  lane: Lane;
  totals: Record<string, ColumnTotals>;
  onMove: (deal: BoardDeal, stage: StageDTO) => void;
  onLoadMore: (stageId: string, offset: number) => void;
  loadingStage: string | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const byId = React.useMemo(() => new Map(deals.map((d) => [d.id, d])), [deals]);
  const stageById = React.useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const lanes = React.useMemo(() => buildLanes(lane, deals), [lane, deals]);
  const grouped = React.useMemo(() => {
    const m = new Map<string, BoardDeal[]>();
    for (const d of deals) (m.get(d.stageId) ?? m.set(d.stageId, []).get(d.stageId)!).push(d);
    for (const list of m.values()) list.sort(sortCards);
    return m;
  }, [deals]);
  const active = activeId ? byId.get(activeId) : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const deal = byId.get(String(e.active.id));
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!deal || !overId) return;
    const stageId = overId.split("|")[1];
    const stage = stageId ? stageById.get(stageId) : undefined;
    if (stage && stage.id !== deal.stageId) onMove(deal, stage);
  };

  const single = lanes.length === 1 && lanes[0]!.key === "all";

  return (
    <DndContext id={`kanban-${pipeline.key}`} sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
        <div className="inline-flex min-w-full flex-col gap-3">
          {/* Column headers with totals (KAN-3) */}
          <div className="sticky top-0 z-10 flex gap-3 bg-bg pb-1">
            {stages.map((st) => (
              <ColumnHeader key={st.id} stage={st} pipeline={pipeline} totals={totals[st.id]} loaded={(grouped.get(st.id) ?? []).length} />
            ))}
          </div>
          {lanes.map((ln) => (
            <section key={ln.key} aria-label={single ? undefined : `Swimlane ${ln.label}`}>
              {!single ? (
                <div className="sticky left-0 mb-1.5 flex w-fit items-center gap-2 text-xs font-medium text-secondary">
                  <span className="uppercase tracking-wider">{ln.label}</span>
                  <span className="text-muted tabular">{deals.filter(ln.match).length}</span>
                </div>
              ) : null}
              <div className="flex gap-3">
                {stages.map((st) => {
                  const dropId = `${ln.key}|${st.id}`;
                  const cards = (grouped.get(st.id) ?? []).filter(ln.match);
                  const loaded = (grouped.get(st.id) ?? []).length;
                  const total = totals[st.id]?.count ?? loaded;
                  const isLastLane = ln.key === lanes[lanes.length - 1]!.key;
                  return (
                    <Column key={dropId} id={dropId} tall={single} stage={st}>
                      {cards.map((d) => (
                        <DraggableCard key={d.id} deal={d} pipeline={pipeline} stages={stages} onMove={onMove} dimmed={activeId === d.id} />
                      ))}
                      {isLastLane && total > loaded ? (
                        <button
                          type="button"
                          disabled={loadingStage === st.id}
                          className="w-full rounded-md border border-dashed border-border-strong py-1.5 text-xs text-secondary hover:text-fg disabled:opacity-50"
                          onClick={() => onLoadMore(st.id, loaded)}
                        >
                          {loadingStage === st.id ? "Loading…" : `Show ${Math.min(100, total - loaded)} more of ${total - loaded}`}
                        </button>
                      ) : null}
                      {cards.length === 0 ? <p className="py-6 text-center text-[11px] text-muted">Drop deals here</p> : null}
                    </Column>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={{ duration: 150, easing: "ease-out" }}>
        {active ? <DealCard deal={active} pipeline={pipeline} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

const CATEGORY_ICON = { won: CheckCircle2, lost: XCircle, hold: PauseCircle } as const;

function ColumnHeader({ stage, pipeline, totals, loaded }: { stage: StageDTO; pipeline: PipelineDTO; totals?: ColumnTotals; loaded: number }) {
  const t = totals ?? { count: 0, muu: 0, gross: 0, net: 0, weighted: 0 };
  const Icon = stage.category !== "open" ? CATEGORY_ICON[stage.category] : null;
  return (
    <div className="w-[272px] shrink-0 rounded-lg border border-border bg-surface-1 px-3 py-2.5">
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="size-3.5 text-muted" aria-hidden /> : null}
        <h2 className="truncate font-sans text-[13px] font-semibold text-fg" title={stage.name}>
          {stage.name}
        </h2>
        <span className="rounded bg-surface-3 px-1.5 text-[11px] font-medium text-secondary tabular" title={loaded < t.count ? `Showing ${loaded} of ${t.count}` : undefined}>
          {fmtNumber(t.count)}
        </span>
        <span className="ml-auto text-[11px] text-muted tabular" title="Stage probability">
          {Math.round(stage.probability * 100)}%
        </span>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 text-[11px] leading-4 text-muted tabular">
        {pipeline.unit === "muu" ? (
          <>
            <Tot label="MUU" value={fmtNumber(t.muu, { compact: true })} />
            <Tot label="Gross" value={fmtUsd(t.gross, { compact: true })} />
            {t.net !== null && t.count ? <Tot label="Net" value={fmtUsd(t.net, { compact: true })} /> : null}
            <Tot label="Wtd" value={fmtUsd(t.weighted, { compact: true })} />
          </>
        ) : pipeline.unit === "usd" ? (
          <>
            <Tot label="Value" value={fmtUsd(t.gross, { compact: true })} />
            <Tot label="Wtd" value={fmtUsd(t.weighted, { compact: true })} />
          </>
        ) : (
          <Tot label="Accounts" value={fmtNumber(t.count)} />
        )}
      </dl>
      {stage.slaDays ? (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-muted">
          <Clock className="size-3" aria-hidden /> SLA {stage.slaDays}d
        </p>
      ) : null}
    </div>
  );
}

function Tot({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <dt>{label}</dt>
      <dd className="text-secondary">{value}</dd>
    </div>
  );
}

function Column({ id, stage, tall, children }: { id: string; stage: StageDTO; tall: boolean; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      aria-label={`${stage.name} column`}
      className={cn(
        "flex w-[272px] shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-1 p-2 transition-colors duration-150",
        tall ? "max-h-[calc(100vh-270px)] min-h-40 overflow-y-auto" : "min-h-20",
        isOver ? "border-border-strong bg-surface-2/60" : "",
        stage.category === "lost" ? "bg-surface-1/60" : "",
      )}
    >
      {children}
    </div>
  );
}

function DraggableCard({ deal, pipeline, stages, onMove, dimmed }: { deal: BoardDeal; pipeline: PipelineDTO; stages: StageDTO[]; onMove: (d: BoardDeal, s: StageDTO) => void; dimmed: boolean }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: deal.id, disabled: !deal.canEdit });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={cn("touch-manipulation outline-none", dimmed ? "opacity-30" : "")} aria-roledescription="Draggable deal">
      <DealCard deal={deal} pipeline={pipeline} stages={stages} onMove={onMove} />
    </div>
  );
}

export function DealCard({
  deal,
  pipeline,
  stages,
  onMove,
  overlay,
}: {
  deal: BoardDeal;
  pipeline: PipelineDTO;
  stages?: StageDTO[];
  onMove?: (d: BoardDeal, s: StageDTO) => void;
  overlay?: boolean;
}) {
  return (
    <article
      className={cn(
        "group relative rounded-md border border-border bg-surface-2 py-2.5 pl-3.5 pr-2.5 transition-colors duration-150 hover:border-border-strong",
        overlay ? "w-[256px] rotate-1 cursor-grabbing border-border-strong" : deal.canEdit ? "cursor-grab" : "",
      )}
    >
      <span aria-hidden className="absolute inset-y-2 left-1 w-[3px] rounded-full" style={{ background: pipeline.color }} />
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <Link
            href={`/deals/${deal.id}`}
            className="line-clamp-2 text-[13px] font-semibold leading-[18px] text-fg hover:underline focus-visible:underline"
            draggable={false}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {deal.name}
          </Link>
          {deal.accountName && deal.accountName !== deal.name ? (
            <p className="truncate text-[11px] text-muted">
              {deal.accountName}
              {deal.accountDomain ? ` · ${deal.accountDomain}` : ""}
            </p>
          ) : deal.accountDomain ? (
            <p className="truncate text-[11px] text-muted">{deal.accountDomain}</p>
          ) : null}
        </div>
        {deal.restricted ? <RestrictedLock className="mt-0.5" /> : null}
        {!overlay && stages && onMove && deal.canEdit ? <MoveMenu deal={deal} stages={stages} onMove={onMove} /> : null}
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 text-[12px] tabular">
        <span className="font-semibold text-body">{valueLabel(pipeline.unit, deal)}</span>
        {pipeline.unit !== "activation" ? (
          <span className="text-[11px] text-muted" title={`Weighted at ${Math.round(deal.probability * 100)}%${deal.overridden ? " (override)" : ""}`}>
            {pipeline.unit === "muu" && deal.grossUsd ? `${fmtUsd(deal.grossUsd, { compact: true })} · ` : ""}
            weighted {fmtUsd(deal.weightedUsd, { compact: true })}
            {deal.overridden ? "*" : ""}
          </span>
        ) : null}
      </div>

      {deal.status === "open" || deal.nextStep ? (
        <div className="mt-1.5">
          <NextStepLine nextStep={deal.nextStep} dueAt={deal.nextStepDueAt} overdueDays={deal.overdueDays} waitingReason={deal.nextStepWaitingReason} compact />
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-1.5">
        <OwnerStack owners={deal.owners} size={20} />
        <span className="text-[11px] text-muted tabular" title="Days in stage">
          {deal.daysInStage}d
        </span>
        <span className="ml-auto flex items-center gap-1">
          <PriorityTag priority={deal.priority} />
          <HealthBadge score={deal.healthScore} explanation={deal.healthExplanation} />
        </span>
      </div>
    </article>
  );
}

/** Non-drag alternative (keyboard / touch / 375px): move via menu — same gates apply. */
function MoveMenu({ deal, stages, onMove }: { deal: BoardDeal; stages: StageDTO[]; onMove: (d: BoardDeal, s: StageDTO) => void }) {
  const open = stages.filter((s) => s.category === "open");
  const closed = stages.filter((s) => s.category !== "open");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="-mr-1 -mt-0.5 rounded p-0.5 text-muted opacity-70 hover:bg-surface-3 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Move ${deal.name} to stage`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted">Move to</p>
        {open.map((s) => (
          <DropdownMenuItem key={s.id} disabled={s.id === deal.stageId} onSelect={() => onMove(deal, s)}>
            {s.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {closed.map((s) => {
          const Icon = CATEGORY_ICON[s.category as keyof typeof CATEGORY_ICON];
          return (
            <DropdownMenuItem key={s.id} disabled={s.id === deal.stageId} onSelect={() => onMove(deal, s)}>
              <Icon className="text-muted" /> {s.name}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
