import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Lock, Minus } from "lucide-react";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtUsd } from "@/lib/format";
import { healthStatus, PIPELINE_COLORS, VIZ, VIZ_OTHER } from "@/lib/palette";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ActivityDelta, BriefDeal, OneOnOneContent } from "@/lib/briefs/one-on-one-core";

function DealLine({ d, right }: { d: BriefDeal; right?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 py-2 text-sm">
      <ColorTick color={PIPELINE_COLORS[d.pipeline] ?? VIZ_OTHER} />
      <span className="min-w-0 flex-1">
        <Link href={`/deals/${d.id}`} className="block truncate text-body hover:text-fg hover:underline">
          {d.restricted ? <Lock className="mr-1 inline size-3 text-muted" aria-label="Restricted" /> : null}
          {d.name}
        </Link>
        {d.detail ? <span className="block truncate text-xs text-muted">{d.detail}</span> : null}
      </span>
      {right ?? (d.valueUsd > 0 ? <span className="tabular text-xs text-secondary">{fmtUsd(d.valueUsd, { compact: true })}</span> : null)}
    </li>
  );
}

function Section({ title, count, children, empty }: { title: string; count?: number; children: React.ReactNode; empty: string }) {
  const has = count == null ? true : count > 0;
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {count != null ? <span className="tabular text-sm text-muted">{count}</span> : null}
      </CardHeader>
      <CardContent className="py-1">{has ? children : <p className="py-3 text-sm text-muted">{empty}</p>}</CardContent>
    </Card>
  );
}

function Delta({ a }: { a: ActivityDelta }) {
  const Icon = a.delta > 0 ? ArrowUpRight : a.delta < 0 ? ArrowDownRight : Minus;
  const text = a.pct == null ? (a.delta > 0 ? `+${a.delta}` : a.delta === 0 ? "—" : `${a.delta}`) : `${a.delta >= 0 ? "+" : ""}${Math.round(a.pct * 100)}%`;
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular text-xs", a.delta < 0 ? "text-secondary" : a.delta > 0 ? "text-fg" : "text-muted")}>
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{a.delta > 0 ? "up" : a.delta < 0 ? "down" : "flat"}</span>
      {text}
    </span>
  );
}

function ActivityChart({ rows }: { rows: ActivityDelta[] }) {
  const kinds = rows.filter((r) => r.kind !== "total");
  const max = Math.max(1, ...kinds.flatMap((r) => [r.current, r.prior]));
  const total = rows.find((r) => r.kind === "total")!;
  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <p>
          <span className="font-display text-[32px] leading-10 text-fg tabular">{total.current}</span>
          <span className="ml-2 text-sm text-muted">activities · {total.prior} the week before</span>
        </p>
        <Delta a={total} />
      </div>
      <div className="mb-2 flex gap-4 text-[11px] text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full" style={{ background: VIZ[0] }} /> This week
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-border-strong" /> Week before
        </span>
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">Activity this week vs the week before</caption>
        <thead className="sr-only">
          <tr>
            <th>Kind</th>
            <th>This week</th>
            <th>Week before</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((r) => (
            <tr key={r.kind} className="align-middle">
              <th scope="row" className="w-20 py-1.5 pr-3 text-left text-xs font-normal text-secondary">
                {r.label}
              </th>
              <td className="py-1.5">
                <div className="space-y-[2px]">
                  <div className="h-2 rounded-r" style={{ width: `${(r.current / max) * 100}%`, minWidth: r.current ? 4 : 0, background: VIZ[0] }} title={`This week: ${r.current}`} />
                  <div className="h-2 rounded-r bg-border-strong" style={{ width: `${(r.prior / max) * 100}%`, minWidth: r.prior ? 4 : 0 }} title={`Week before: ${r.prior}`} />
                </div>
              </td>
              <td className="w-10 py-1.5 pl-2 text-right tabular text-xs text-body">{r.current}</td>
              <td className="w-10 py-1.5 text-right tabular text-xs text-muted">{r.prior}</td>
              <td className="w-16 py-1.5 text-right">
                <Delta a={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The 1:1 brief (server component; content was generated with the viewer's permissions). */
export function BriefView({ content, engine, tz }: { content: OneOnOneContent; engine: string; tz: string }) {
  const m = content.metrics;
  const firstName = content.repName.split(/\s+/)[0];
  const commitments = m.closeDatePushes.length + m.overdueNextSteps.length;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-surface-2 p-5" aria-label="Summary and coaching prompts">
        <div className="border-l border-white/80 pl-4">
          <p className="font-display text-sm italic text-secondary">{engine === "heuristic" ? "This week" : "Copilot"}</p>
          <p className="mt-1 text-[15px] leading-6 text-fg">{content.headline}</p>
        </div>
        <ol className="mt-5 grid gap-3 md:grid-cols-3">
          {content.coachingPrompts.map((p, i) => (
            <li key={i} className="flex gap-3 rounded-md border border-border bg-surface-1 p-3">
              <span className="font-display text-2xl leading-7 text-muted tabular" aria-hidden>
                {i + 1}
              </span>
              <span className="text-sm leading-6 text-body">{p}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: "Won", value: m.won.length },
          { label: "Advanced", value: m.advanced.length },
          { label: "Slipped", value: m.slipped.length },
          { label: "New deals", value: m.created.length },
          { label: "Overdue tasks", value: m.overdueTasks.count },
        ].map((x) => (
          <div key={x.label} className="rounded-lg border border-border bg-surface-1 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{x.label}</p>
            <p className="mt-1 font-display text-[28px] leading-9 text-fg tabular">{x.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-base">Activity vs the week before</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityChart rows={m.activity} />
          </CardContent>
        </Card>

        <Section title="Top risks" count={m.risks.length} empty={`No open deal of ${firstName}'s looks at risk.`}>
          <ul className="divide-y divide-border">
            {m.risks.map((d) => (
              <DealLine key={d.id} d={d} right={d.health != null ? <StatusBadge status={healthStatus(d.health)} label={`${d.health}`} /> : undefined} />
            ))}
          </ul>
        </Section>

        <Section title="Won & lost" count={m.won.length + m.lost.length} empty="No deals closed this week.">
          <ul className="divide-y divide-border">
            {m.won.map((d) => (
              <DealLine key={d.id} d={{ ...d, detail: "Won" }} />
            ))}
            {m.lost.map((d) => (
              <DealLine key={d.id} d={{ ...d, detail: d.detail ? `Lost · ${d.detail}` : "Lost" }} />
            ))}
          </ul>
        </Section>

        <Section title="Pipeline movement" count={m.advanced.length + m.slipped.length} empty="No stage changes this week.">
          <ul className="divide-y divide-border">
            {m.advanced.slice(0, 8).map((d) => (
              <DealLine key={`a-${d.id}`} d={d} right={<span className="inline-flex items-center gap-1 text-xs text-secondary"><ArrowUpRight className="size-3.5" aria-hidden />Advanced</span>} />
            ))}
            {m.slipped.slice(0, 8).map((d) => (
              <DealLine key={`s-${d.id}`} d={d} right={<span className="inline-flex items-center gap-1 text-xs text-secondary"><ArrowDownRight className="size-3.5" aria-hidden />Slipped</span>} />
            ))}
          </ul>
        </Section>

        <Section title="Slipped commitments" count={commitments} empty="Every close date held and every next step is on time.">
          <ul className="divide-y divide-border">
            {m.closeDatePushes.map((d) => (
              <DealLine key={`c-${d.id}`} d={{ ...d, detail: `Close date pushed ${d.detail ?? ""}`.trim() }} />
            ))}
            {m.overdueNextSteps.slice(0, 10).map((d) => (
              <DealLine key={`n-${d.id}`} d={d} />
            ))}
          </ul>
        </Section>

        <Section title="Overdue tasks" count={m.overdueTasks.count} empty="Nothing overdue.">
          <ul className="divide-y divide-border">
            {m.overdueTasks.top.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{t.title}</span>
                  {t.dealName ? <span className="block truncate text-xs text-muted">{t.dealName}</span> : null}
                </span>
                <span className="text-xs text-muted tabular">due {formatInTz(t.dueAt, tz, "short")}</span>
              </li>
            ))}
          </ul>
          {!m.overdueTasks.top.length ? <p className="py-3 text-sm text-muted">{m.overdueTasks.count} overdue — ask {firstName} to walk you through them.</p> : null}
          {m.overdueTasks.top.length > 0 && m.overdueTasks.count > m.overdueTasks.top.length ? (
            <Link href="/tasks?tab=team" className="mt-1 inline-flex items-center gap-1 pb-2 text-xs text-secondary hover:text-fg">
              All {m.overdueTasks.count} on the team tasks list <ArrowRight className="size-3" aria-hidden />
            </Link>
          ) : null}
        </Section>
      </div>
      <p className="text-xs text-muted">
        Covers {formatInTz(content.window.start, tz, "short")} – {formatInTz(content.window.end, tz, "short")} vs the 7 days before · {m.openDeals.count} open deals
        {m.openDeals.valueUsd > 0 ? ` · ${fmtUsd(m.openDeals.valueUsd, { compact: true })} gross` : ""} · only deals you can see are included.
      </p>
    </div>
  );
}
