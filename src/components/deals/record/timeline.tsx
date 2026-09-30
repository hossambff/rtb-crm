"use client";
import * as React from "react";
import { ArrowRightLeft, AtSign, Bot, Loader2, Mail, MessageSquareText, Phone, Pin, PinOff, Settings2, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { logDealActivity, toggleActivityPin } from "@/lib/deals/actions";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";

export type TimelineItem = {
  id: string;
  type: string;
  source: string;
  subject: string | null;
  body: string | null;
  direction: string | null;
  occurredAt: string;
  durationMin: number | null;
  pinned: boolean;
  actorName: string | null;
  actorImage: string | null;
  contactName: string | null;
  private: boolean;
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  email: Mail,
  call: Phone,
  meeting: Video,
  note: MessageSquareText,
  linkedin: AtSign,
  stage_change: ArrowRightLeft,
  field_change: Settings2,
  system: Settings2,
  agent: Bot,
};

const FILTERS: { key: string; label: string; types: string[] | null }[] = [
  { key: "all", label: "All", types: null },
  { key: "touches", label: "Touches", types: ["email", "call", "meeting", "linkedin"] },
  { key: "notes", label: "Notes", types: ["note"] },
  { key: "changes", label: "Changes", types: ["stage_change", "field_change", "system", "agent"] },
];

/** CARD-3 unified timeline: pinned first, filter by type, inline note composer. */
export function Timeline({ dealId, items, canLog, canPin }: { dealId: string; items: TimelineItem[]; canLog: boolean; canPin: boolean }) {
  const [filter, setFilter] = React.useState("all");
  const [note, setNote] = React.useState("");
  const [run, pending] = useRun();
  const [pinRun] = useRun();
  const types = FILTERS.find((f) => f.key === filter)?.types;
  const shown = types ? items.filter((i) => types.includes(i.type)) : items;

  return (
    <section aria-labelledby="timeline-h" className="rounded-lg border border-border bg-surface-1">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 id="timeline-h" className="font-display text-lg text-fg">
          Timeline
        </h2>
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Filter timeline">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn("rounded px-2 py-1 text-xs font-medium", filter === f.key ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {canLog ? (
        <form
          className="border-b border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            run(() => logDealActivity({ dealId, type: "note", body: note.trim() }), { success: "Note added", onOk: () => setNote("") });
          }}
        >
          <Textarea aria-label="Add a note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note… (visible to everyone who can see this deal)" className="min-h-14" />
          <div className="mt-2 flex justify-end">
            <Button type="submit" size="sm" variant="primary" disabled={pending || !note.trim()}>
              {pending ? <Loader2 className="animate-spin" /> : null} Add note
            </Button>
          </div>
        </form>
      ) : null}
      {shown.length === 0 ? (
        <div className="p-4">
          <EmptyState title="Nothing here yet" description="Emails, calls, meetings, notes and stage changes appear here as they happen." />
        </div>
      ) : (
        <ol className="relative px-4 py-3">
          <span aria-hidden className="absolute bottom-4 left-[29px] top-4 w-px bg-border" />
          {shown.map((a) => {
            const Icon = ICONS[a.type] ?? Settings2;
            return (
              <li key={a.id} id={`activity-${a.id}`} className="relative flex gap-3 rounded-md py-2.5 transition-shadow">
                <span className="relative z-[1] mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-2">
                  <Icon className="size-3.5 text-secondary" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[13px] font-medium text-fg">{a.subject ?? labelFor(a.type)}</span>
                    {a.pinned ? <Pin className="size-3 text-fg" aria-label="Pinned" /> : null}
                    <span className="text-[11px] text-muted" title={fmtDate(a.occurredAt, "d MMM yyyy HH:mm")}>
                      {labelFor(a.type)}
                      {a.direction ? ` · ${a.direction}` : ""}
                      {a.durationMin ? ` · ${a.durationMin} min` : ""}
                      {a.contactName ? ` · ${a.contactName}` : ""} · <RelativeTime iso={a.occurredAt} />
                    </span>
                  </div>
                  {a.private ? (
                    <p className="mt-1 text-xs italic text-muted">Private mailbox content hidden.</p>
                  ) : a.body ? (
                    <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-[13px] leading-5 text-body">{a.body}</p>
                  ) : null}
                  {a.actorName ? (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                      <Avatar name={a.actorName} src={a.actorImage} size={16} /> {a.actorName}
                      {a.source !== "manual" ? ` · via ${a.source}` : ""}
                    </p>
                  ) : a.source !== "manual" ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                      <Users className="size-3" /> via {a.source}
                    </p>
                  ) : null}
                </div>
                {canPin && (a.type === "note" || a.pinned) ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={a.pinned ? "Unpin" : "Pin to top"}
                    onClick={() => pinRun(() => toggleActivityPin({ activityId: a.id }))}
                  >
                    {a.pinned ? <PinOff /> : <Pin />}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function labelFor(type: string) {
  return (
    {
      email: "Email",
      call: "Call",
      meeting: "Meeting",
      note: "Note",
      linkedin: "LinkedIn",
      stage_change: "Stage change",
      field_change: "Field change",
      system: "System",
      agent: "Copilot",
    } as Record<string, string>
  )[type] ?? type;
}
