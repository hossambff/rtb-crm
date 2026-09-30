import Link from "next/link";
import { ArrowRight, CalendarClock, Lock, Mail, Sparkles } from "lucide-react";
import { Badge, ColorTick, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Stat } from "@/components/ui/misc";
import { PIPELINE_COLORS, healthStatus } from "@/lib/palette";
import { fmtInTz } from "@/lib/tasks/core";
import type { AttentionDeal } from "@/lib/tasks/home";
import type { Severity } from "@/lib/alerts/rules";
import { SeverityBadge } from "@/components/alerts/severity-badge";

export function HomeSection({
  title,
  href,
  hrefLabel = "View all",
  count,
  children,
  className,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  count?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="items-center">
        <CardTitle className="flex items-center gap-2">
          {title}
          {count ? <span className="font-sans text-xs font-medium text-muted tabular">{count}</span> : null}
        </CardTitle>
        {href ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={href}>
              {hrefLabel} <ArrowRight />
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function HeroStats({
  overdue,
  dueToday,
  alerts,
  needNextStep,
}: {
  overdue: number;
  dueToday: number;
  alerts: Record<Severity, number>;
  needNextStep: number;
}) {
  const total = alerts.critical + alerts.serious + alerts.warning + alerts.info;
  const sev = (["critical", "serious", "warning", "info"] as const).filter((k) => alerts[k] > 0);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Link href="/tasks?tab=mine" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
        <Stat label="Overdue tasks" value={overdue} hint={overdue ? <StatusBadge status="critical" label="Needs action" /> : "Nothing overdue"} />
      </Link>
      <Link href="/tasks?tab=mine" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
        <Stat label="Due today" value={dueToday} hint={dueToday ? "Tasks & commitments" : "Clear day"} />
      </Link>
      <Link href="/tasks?tab=alerts" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
        <Stat
          label="Open alerts"
          value={total}
          hint={
            sev.length ? (
              <span className="flex flex-wrap gap-1">
                {sev.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <SeverityBadge severity={k} />
                    <span className="tabular text-secondary">{alerts[k]}</span>
                  </span>
                ))}
              </span>
            ) : (
              "Nothing slipping"
            )
          }
        />
      </Link>
      <Link href="/pipelines" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
        <Stat label="Deals needing next step" value={needNextStep} hint={needNextStep ? "Missing or overdue next step" : "Every deal has a next step"} />
      </Link>
    </div>
  );
}

type MeetingItem = { id: string; title: string | null; startsAt: string | null; endsAt: string | null; attendees: string[]; dealId: string | null; prepBrief: string | null };

export function MeetingsList({ meetings, tz, nowIso }: { meetings: MeetingItem[]; tz: string; nowIso: string }) {
  if (!meetings.length) return <EmptyState title="No meetings today" description="Calendar meetings appear here with a prep brief link." />;
  const now = new Date(nowIso);
  return (
    <ul className="-my-2 divide-y divide-border">
      {meetings.map((m) => {
        const live = m.startsAt && m.endsAt && new Date(m.startsAt) <= now && new Date(m.endsAt) > now;
        const past = m.endsAt && new Date(m.endsAt) <= now;
        return (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <CalendarClock className="size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm ${past ? "text-muted" : "text-fg"}`}>{m.title ?? "Untitled meeting"}</p>
              <p className="text-[11px] text-muted tabular">
                {fmtInTz(m.startsAt, tz, "time")}
                {m.endsAt ? `–${fmtInTz(m.endsAt, tz, "time")}` : ""} · {m.attendees.length} attendee{m.attendees.length === 1 ? "" : "s"}
              </p>
            </div>
            {live ? <StatusBadge status="good" label="Now" /> : null}
            {!past ? (
              <Button asChild size="sm" variant={m.prepBrief ? "secondary" : "ghost"}>
                <Link href={`/copilot?meetingId=${m.id}`}>
                  <Sparkles /> Prep
                </Link>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const REASON_LABEL: Record<AttentionDeal["reasons"][number], string> = {
  no_next_step: "No next step",
  overdue: "Next step overdue",
  stale: "Stale beyond SLA",
  health: "Low health",
};

export function AttentionDeals({ deals, tz }: { deals: AttentionDeal[]; tz: string }) {
  if (!deals.length) return <EmptyState title="All deals on track" description="Every deal you own has a next step, recent activity and healthy score." />;
  return (
    <ul className="-my-2 divide-y divide-border">
      {deals.map((d) => (
        <li key={d.id} className="flex items-start gap-3 py-2.5">
          <ColorTick color={PIPELINE_COLORS[d.pipelineKey] ?? "#828282"} className="mt-1" />
          <div className="min-w-0 flex-1">
            <Link href={`/deals/${d.id}`} className="block truncate text-sm font-medium text-fg hover:underline">
              {d.name}
            </Link>
            <p className="truncate text-[11px] text-muted">
              {d.pipelineKey} · {d.stageName}
              {d.nextStep ? ` · ${d.nextStep}` : ""}
              {d.nextStepDueAt ? ` · due ${fmtInTz(d.nextStepDueAt, tz, "date")}` : ""}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {d.reasons.map((r) =>
                r === "health" ? (
                  <StatusBadge key={r} status={healthStatus(d.healthScore)} label={`Health ${d.healthScore}`} />
                ) : r === "overdue" ? (
                  <StatusBadge key={r} status="serious" label={REASON_LABEL[r]} />
                ) : (
                  <StatusBadge key={r} status="warning" label={REASON_LABEL[r]} />
                ),
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

type ThreadItem = { id: string; subject: string | null; snippet: string | null; participants: string[]; lastMessageAt: string | null; private: boolean };

export function InboxAwaiting({ threads, tz }: { threads: ThreadItem[]; tz: string }) {
  if (!threads.length) return <EmptyState title="Inbox zero (for prospects)" description="Threads waiting on your reply show up here once Gmail is connected." />;
  return (
    <ul className="-my-2 divide-y divide-border">
      {threads.map((t) => (
        <li key={t.id} className="flex items-start gap-3 py-2.5">
          {t.private ? <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-label="Private" /> : <Mail className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />}
          <div className="min-w-0 flex-1">
            <Link href={`/inbox?thread=${t.id}`} className="block truncate text-sm text-fg hover:underline">
              {t.subject ?? "(no subject)"}
            </Link>
            <p className="truncate text-[11px] text-muted">
              {t.participants.slice(0, 2).join(", ")} · waiting since {fmtInTz(t.lastMessageAt, tz)}
            </p>
          </div>
          <Badge>Reply</Badge>
        </li>
      ))}
    </ul>
  );
}
