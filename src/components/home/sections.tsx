import Link from "next/link";
import { briefHref } from "@/lib/briefs/meeting-core";
import { ArrowRight, CalendarClock, Sparkles } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Term } from "@/components/ui/term";
import { fmtInTz } from "@/lib/tasks/core";
import type { TodayMeeting } from "@/lib/queue";
import type { Severity } from "@/lib/alerts/rules";

export function HomeSection({
  title,
  href,
  hrefLabel = "View all",
  count,
  children,
  className,
}: {
  title: React.ReactNode;
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

/** Compact "at a glance" numbers for the side column (each one links to where you'd fix it). */
export function GlanceStats({
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
  const totalAlerts = alerts.critical + alerts.serious + alerts.warning + alerts.info;
  const urgentAlerts = alerts.critical + alerts.serious;
  const tiles = [
    { label: "Overdue", value: overdue, href: "/tasks?tab=mine", hint: overdue ? <StatusBadge status="critical" label="Act today" /> : "Nothing overdue" },
    { label: "Due today", value: dueToday, href: "/tasks?tab=mine", hint: dueToday ? "Tasks & promises" : "Clear day" },
    {
      label: "Open alerts",
      value: totalAlerts,
      href: "/tasks?tab=alerts",
      hint: urgentAlerts ? <StatusBadge status="serious" label={`${urgentAlerts} serious+`} /> : totalAlerts ? "None serious" : "Nothing slipping",
    },
    { label: "Need a next step", value: needNextStep, href: "/deals?owner=me&nonext=1", hint: needNextStep ? "Missing or overdue" : "All deals moving" },
  ];
  return (
    <section aria-labelledby="glance-title">
      <h2 id="glance-title" className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
        At a glance · every open deal needs a <Term id="nextStep">next step</Term>
      </h2>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={t.href}
            className="bg-surface-1 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{t.label}</p>
            <p className="mt-1 font-display text-[26px] leading-8 text-fg tabular">{t.value}</p>
            <div className="mt-0.5 text-[11px] text-muted">{t.hint}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function MeetingsList({ meetings, tz, nowIso }: { meetings: TodayMeeting[]; tz: string; nowIso: string }) {
  if (!meetings.length)
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-muted">No meetings today.</p>
        <p className="mt-1 text-xs text-muted">Calendar meetings show up here with a prep brief.</p>
      </div>
    );
  const now = new Date(nowIso);
  return (
    <ul className="-my-2 divide-y divide-border">
      {meetings.map((m) => {
        const live = m.startsAt && m.endsAt && new Date(m.startsAt) <= now && new Date(m.endsAt) > now;
        const past = m.endsAt ? new Date(m.endsAt) <= now : Boolean(m.startsAt && new Date(m.startsAt).getTime() + 3_600_000 <= now.getTime());
        return (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <CalendarClock className="size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm ${past ? "text-muted line-through decoration-border-strong" : "text-fg"}`}>{m.title ?? "Untitled meeting"}</p>
              <p className="text-[11px] text-muted tabular">
                {fmtInTz(m.startsAt, tz, "time")}
                {m.endsAt ? `–${fmtInTz(m.endsAt, tz, "time")}` : ""} · {m.attendees} attendee{m.attendees === 1 ? "" : "s"}
              </p>
            </div>
            {live ? <StatusBadge status="good" label="Now" /> : null}
            {!past ? (
              <Button asChild size="sm" variant={m.hasBrief ? "secondary" : "ghost"}>
                <Link href={briefHref(m.id)} aria-label={`${m.hasBrief ? "Open brief" : "Prep"}: ${m.title ?? "meeting"}`}>
                  <Sparkles /> {m.hasBrief ? "Brief" : "Prep"}
                </Link>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
