import { CalendarDays, FileUp, Mail, MessageSquare, Phone, Pin, Sparkles, StickyNote, Workflow } from "lucide-react";
import { EmptyState } from "@/components/ui/misc";
import { fmtDate, fmtRelative } from "@/lib/format";

export type TimelineItem = {
  id: string;
  type: string;
  source: string;
  subject: string | null;
  body: string | null;
  occurredAt: Date;
  actorName: string | null;
  pinned?: boolean;
};

const ICON: Record<string, typeof Mail> = {
  email: Mail,
  call: Phone,
  meeting: CalendarDays,
  note: StickyNote,
  linkedin: MessageSquare,
  stage_change: Workflow,
  field_change: Workflow,
  system: Workflow,
  agent: Sparkles,
};

export function ActivityTimeline({ items, empty = "No activity yet" }: { items: TimelineItem[]; empty?: string }) {
  if (!items.length) return <EmptyState title={empty} description="Emails, calls, meetings and notes linked to this record appear here." />;
  return (
    <ol className="relative space-y-0 border-l border-border pl-5">
      {items.map((a) => {
        const Icon = a.source === "import" ? FileUp : (ICON[a.type] ?? StickyNote);
        return (
          <li key={a.id} className="relative pb-5 last:pb-0">
            <span className="absolute -left-[29px] top-0.5 flex size-[17px] items-center justify-center rounded-full border border-border-strong bg-bg">
              <Icon className="size-2.5 text-secondary" aria-hidden />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
              <span className="font-medium text-secondary">{a.subject ?? a.type.replace(/_/g, " ")}</span>
              {a.pinned ? <Pin className="size-3" aria-label="Pinned" /> : null}
              <time dateTime={a.occurredAt.toISOString()} title={fmtDate(a.occurredAt, "d MMM yyyy HH:mm")}>
                {fmtRelative(a.occurredAt)}
              </time>
              {a.actorName ? <span>· {a.actorName}</span> : null}
              {a.source !== "manual" ? <span>· {a.source}</span> : null}
            </div>
            {a.body ? <p className="mt-1 whitespace-pre-line text-sm text-body line-clamp-4">{a.body}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
