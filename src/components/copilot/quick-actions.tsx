"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, ChartNoAxesColumn, ListChecks, Loader2, Siren } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { fmtDate, fmtUsd } from "@/lib/format";
import { runCopilotQuickAction } from "@/lib/copilot/actions";
import type { CopilotContext } from "@/lib/copilot/types";
import { BriefCard, ReportCard } from "./tool-parts";

type Result = Awaited<ReturnType<typeof runCopilotQuickAction>>;
type Data = Extract<Result, { ok: true }>["data"];
type WorkItem = Record<string, unknown>;

/** Deterministic, no-AI shortcuts (also the degraded mode when the model is unavailable). */
export function QuickActions({ context }: { context: CopilotContext }) {
  const [data, setData] = useState<Data | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (kind: "pipeline" | "tasks" | "alerts" | "at_risk" | "prep", extra: { basis?: "gross" | "net" } = {}) => {
    setActive(kind);
    start(async () => {
      const r = await runCopilotQuickAction({ kind, ...extra, dealId: context.dealId, meetingId: context.meetingId });
      if (r.ok) setData(r.data);
      else {
        setData(null);
        toast.error(r.error);
      }
    });
  };
  const actions = [
    { kind: "at_risk" as const, label: "Deals at risk", icon: <AlertTriangle /> },
    { kind: "tasks" as const, label: "My open tasks", icon: <ListChecks /> },
    { kind: "alerts" as const, label: "My alerts", icon: <Siren /> },
    { kind: "pipeline" as const, label: "Pipeline by stage", icon: <ChartNoAxesColumn /> },
    { kind: "prep" as const, label: context.dealId || context.meetingId ? "Prep this meeting" : "Prep next meeting", icon: <CalendarClock /> },
  ];
  return (
    <section aria-label="Quick actions" className="rounded-lg border border-border bg-surface-1">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Quick actions</p>
        <p className="text-[11px] text-muted">Instant, no AI — works even if the model is down.</p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 p-3 lg:grid-cols-1">
        {actions.map((a) => (
          <Button key={a.kind} variant="secondary" size="sm" className="justify-start" disabled={pending} onClick={() => run(a.kind)} aria-pressed={active === a.kind}>
            {pending && active === a.kind ? <Loader2 className="animate-spin" /> : a.icon}
            {a.label}
          </Button>
        ))}
      </div>
      {data ? (
        <div className="border-t border-border px-3 pb-3">
          {data.kind === "pipeline" ? (
            <>
              <div className="mt-2 flex gap-1">
                {(["gross", "net"] as const).map((b) => (
                  <Button key={b} size="sm" variant={data.report.basis === b ? "primary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => run("pipeline", { basis: b })}>
                    {b.toUpperCase()}
                  </Button>
                ))}
              </div>
              <ReportCard report={data.report} />
            </>
          ) : data.kind === "prep" ? (
            <BriefCard output={data.brief} />
          ) : (
            <WorkList kind={data.kind} items={(data.work.items ?? []) as WorkItem[]} />
          )}
        </div>
      ) : null}
    </section>
  );
}

function WorkList({ kind, items }: { kind: string; items: WorkItem[] }) {
  if (!items.length)
    return <p className="mt-3 text-[13px] text-muted">{kind === "at_risk" ? "Nothing at risk — every open deal has a next step and recent activity." : kind === "alerts" ? "No open alerts." : "No open tasks."}</p>;
  return (
    <ul className="mt-2 divide-y divide-border text-[13px]">
      {items.slice(0, 12).map((it) => {
        const deal = (it.deal ?? null) as { name?: string; href?: string } | null;
        const href = (it.href as string | undefined) ?? deal?.href;
        const title = String(it.name ?? it.title ?? "");
        return (
          <li key={String(it.id)} className="py-2">
            <div className="flex items-start justify-between gap-2">
              {href ? (
                <Link href={href} className="text-body underline decoration-border-strong underline-offset-2 hover:decoration-white">
                  {title}
                </Link>
              ) : (
                <span className="text-body">{title}</span>
              )}
              {kind === "tasks" && it.overdue ? <StatusBadge status="serious" label="Overdue" /> : null}
              {kind === "alerts" && typeof it.severity === "string" ? (
                <StatusBadge status={it.severity === "critical" ? "critical" : it.severity === "serious" ? "serious" : "warning"} label={it.severity} />
              ) : null}
            </div>
            <p className="text-[11px] text-muted">
              {kind === "tasks" ? `${it.dueAt ? `Due ${fmtDate(it.dueAt as string)}` : "No due date"}${deal?.name ? ` · ${deal.name}` : ""}` : null}
              {kind === "alerts" ? String(it.suggestedAction ?? it.detail ?? "") : null}
              {kind === "at_risk" ? `${String(it.pipeline)} · ${String(it.stage)} · ${fmtUsd((it.value as { grossUsd?: number })?.grossUsd ?? 0, { compact: true })} gross` : null}
            </p>
            {kind === "at_risk" && Array.isArray(it.reasons) ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {(it.reasons as string[]).map((r) => (
                  <li key={r}>
                    <StatusBadge status="warning" label={r} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
