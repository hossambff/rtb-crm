"use client";
import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardCopy,
  FileSearch,
  Globe,
  ListChecks,
  Loader2,
  Lock,
  Search,
  ShieldCheck,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { fmtDate, fmtNumber, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { COPILOT_TOOL_LABELS, type ClaimHitView, type CreateTaskOutput, type EmailDraft, type MeetingBrief, type PipelineReport, type StageSuggestionOutput } from "@/lib/copilot/types";
import { applyCopilotStageChange, confirmCopilotTask, undoCopilotTask } from "@/lib/copilot/actions";
import { Markdown } from "./markdown";

/* ───────────── applied-state (persisted per tool call) ───────────── */

const APPLIED_KEY = "rtb.copilot.applied.v1";
const listeners = new Set<() => void>();
function readApplied(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
let appliedCache: Record<string, string> | null = null;
function snapshot() {
  if (appliedCache === null) appliedCache = typeof window === "undefined" ? {} : readApplied();
  return appliedCache;
}
function setApplied(id: string, value: string) {
  const next = { ...snapshot(), [id]: value };
  const keys = Object.keys(next);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete next[k];
  appliedCache = next;
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}
const EMPTY: Record<string, string> = {};
function useApplied(id: string): [string | undefined, (v: string) => void] {
  const map = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
    () => EMPTY,
  );
  return [map[id], (v) => setApplied(id, v)];
}

/* ───────────── shared bits ───────────── */

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

function CardShell({ title, icon, children, className }: { title: React.ReactNode; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("my-2 rounded-md border border-border bg-surface-1", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-secondary [&_svg]:size-3.5">
        {icon}
        {title}
      </div>
      <div className="px-3 py-2.5 text-[13px] leading-5">{children}</div>
    </div>
  );
}

type RefLink = { name: string; href: string; sub?: string };

/** Collect record links from any tool output (for chips + "Sources"). */
export function collectRefs(output: unknown): RefLink[] {
  const out: RefLink[] = [];
  const push = (name: unknown, href: unknown, sub?: unknown) => {
    if (typeof href === "string" && href.startsWith("/") && typeof name === "string" && name) out.push({ name, href, sub: typeof sub === "string" ? sub : undefined });
  };
  const o = asObj(output);
  push(o.name, o.href);
  for (const key of ["results", "deals", "items", "stakeholders", "contacts"]) {
    const arr = o[key];
    if (Array.isArray(arr))
      for (const r of arr) {
        const x = asObj(r);
        push(x.name ?? x.title, x.href, x.subtitle ?? x.stage);
        const deal = asObj(x.deal);
        push(deal.name, deal.href);
      }
  }
  return out;
}

/* ───────────── chip (read tools) ───────────── */

const ICONS: Record<string, React.ReactNode> = {
  search_records: <Search />,
  find_deals: <FileSearch />,
  get_deal: <FileSearch />,
  get_account: <FileSearch />,
  get_timeline: <ListChecks />,
  list_my_work: <ListChecks />,
  check_claims: <ShieldCheck />,
  web_research: <Globe />,
};

function chipSummary(name: string, input: Obj, output: Obj): string {
  if (output.error) return String(output.error);
  switch (name) {
    case "search_records":
      return `“${String(input.query ?? "")}” · ${Array.isArray(output.results) ? output.results.length : 0} result(s)`;
    case "find_deals":
      return `${output.count ?? 0} deal(s)`;
    case "get_deal":
    case "get_account":
      return String(output.name ?? "");
    case "get_timeline":
      return `${output.count ?? 0} activit${output.count === 1 ? "y" : "ies"}`;
    case "list_my_work":
      return `${String(input.kind ?? "").replace(/_/g, " ")} · ${output.count ?? 0}`;
    case "check_claims":
      return String(output.verdict ?? "");
    case "web_research":
      return output.configured === false ? "not configured" : `${Array.isArray(output.results) ? output.results.length : 0} source(s) · research estimate`;
    default:
      return "";
  }
}

export function ToolChip({ name, state, input, output, errorText }: { name: string; state: string; input: unknown; output: unknown; errorText?: string }) {
  const [open, setOpen] = useState(false);
  const label = COPILOT_TOOL_LABELS[name] ?? { running: name, done: name };
  const running = state === "input-streaming" || state === "input-available";
  const o = asObj(output);
  const denied = typeof o.error === "string";
  const refs = collectRefs(output).slice(0, 12);
  const webResults = name === "web_research" && Array.isArray(o.results) ? (o.results as Obj[]) : [];
  const claimHits = name === "check_claims" && Array.isArray(o.hits) ? (o.hits as ClaimHitView[]) : [];
  const expandable = !running && (refs.length > 0 || webResults.length > 0 || claimHits.length > 0);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 py-0.5 text-[12px] text-muted transition-colors duration-150 [&_svg]:size-3.5",
          expandable && "hover:border-border-strong hover:text-secondary",
        )}
      >
        {running ? <Loader2 className="animate-spin" /> : denied ? <Lock /> : (ICONS[name] ?? <Sparkles />)}
        <span className="shrink-0 whitespace-nowrap text-secondary">{running ? `${label.running}…` : label.done}</span>
        {!running && (state === "output-error" ? <span className="truncate">failed{errorText ? ` · ${errorText.slice(0, 80)}` : ""}</span> : <span className="truncate">{chipSummary(name, asObj(input), o)}</span>)}
        {expandable ? <ChevronRight className={cn("transition-transform duration-150", open && "rotate-90")} /> : null}
      </button>
      {open ? (
        <div className="ml-3 mt-1 space-y-1 border-l border-border pl-3 text-[12px]">
          {refs.map((r, i) => (
            <div key={`${r.href}-${i}`} className="flex items-baseline gap-2">
              <Link href={r.href} className="text-body underline decoration-border-strong underline-offset-2 hover:decoration-white">
                {r.name}
              </Link>
              {r.sub ? <span className="truncate text-muted">{r.sub}</span> : null}
            </div>
          ))}
          {webResults.map((w, i) => (
            <div key={i} className="truncate">
              <a href={String(w.url ?? "#")} target="_blank" rel="noopener noreferrer nofollow" className="text-body underline decoration-border-strong underline-offset-2">
                {String(w.title ?? w.url ?? "source")}
              </a>{" "}
              <span className="text-muted">· research estimate</span>
            </div>
          ))}
          {claimHits.length ? <ClaimHits hits={claimHits} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ───────────── claims ───────────── */

function ClaimHits({ hits, onUseAlternative }: { hits: ClaimHitView[]; onUseAlternative?: (h: ClaimHitView) => void }) {
  return (
    <ul className="space-y-2">
      {hits.map((h, i) => (
        <li key={`${h.claimId}-${i}`} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={h.status === "banned" ? "critical" : "warning"} label={h.status === "banned" ? "Banned claim" : "Restricted claim"} />
            <span className="text-secondary">“{h.match}”</span>
          </div>
          {h.alternative ? (
            <div className="flex flex-wrap items-start gap-2 text-muted">
              <span>
                Approved alternative: <span className="text-body">{h.alternative}</span>
              </span>
              {onUseAlternative ? (
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => onUseAlternative(h)}>
                  Use alternative
                </Button>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ───────────── task card ───────────── */

export function TaskCard({ callId, output }: { callId: string; output: CreateTaskOutput }) {
  const [applied, setAppliedState] = useApplied(callId);
  const [pending, start] = useTransition();
  if (output.mode === "refused") return <CardShell title="Task not created" icon={<Lock />}><p className="text-muted">{output.error}</p></CardShell>;
  const t = output.task;
  const details = (
    <div className="space-y-1">
      <p className="font-medium text-fg">{t.title}</p>
      <p className="text-muted">
        {t.dueAt ? `Due ${fmtDate(t.dueAt, "EEE d MMM, HH:mm")}` : "No due date"}
        {t.assigneeName ? ` · ${t.assigneeName}` : ""}
        {t.dealId ? (
          <>
            {" · "}
            <Link href={`/deals/${t.dealId}`} className="underline decoration-border-strong underline-offset-2 hover:text-fg">
              {t.dealName ?? "Deal"}
            </Link>
          </>
        ) : null}
      </p>
      {t.evidence ? <p className="border-l border-border-strong pl-2 text-secondary">“{t.evidence}”</p> : null}
    </div>
  );
  if (output.mode === "created") {
    const undone = applied === "undone";
    return (
      <CardShell title={undone ? "Task undone" : "Task created by Copilot"} icon={undone ? <Undo2 /> : <Check />}>
        {details}
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="secondary" asChild>
            <Link href="/tasks">Open tasks</Link>
          </Button>
          {!undone ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await undoCopilotTask({ taskId: output.taskId });
                  if (r.ok) {
                    setAppliedState("undone");
                    toast.success("Task removed");
                  } else toast.error(r.error);
                })
              }
            >
              <Undo2 /> Undo
            </Button>
          ) : null}
        </div>
      </CardShell>
    );
  }
  return (
    <CardShell title="Suggested task" icon={<ListChecks />}>
      {details}
      <p className="mt-1 text-[12px] text-muted">{output.note}</p>
      <div className="mt-2 flex items-center gap-2">
        {applied?.startsWith("created") ? (
          <StatusBadge status="good" label="Created" />
        ) : applied === "dismissed" ? (
          <span className="text-muted">Dismissed</span>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await confirmCopilotTask({
                    title: t.title,
                    dueAt: t.dueAt ?? null,
                    dealId: t.dealId ?? null,
                    assigneeId: t.assigneeId,
                    description: t.description ?? null,
                    evidence: t.evidence ?? null,
                  });
                  if (r.ok) {
                    setAppliedState(`created:${r.data.taskId}`);
                    toast.success("Task created");
                  } else toast.error(r.error);
                })
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : <Check />} Create task
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAppliedState("dismissed")}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </CardShell>
  );
}

/* ───────────── stage card ───────────── */

export function StageCard({ callId, output }: { callId: string; output: StageSuggestionOutput }) {
  const [applied, setAppliedState] = useApplied(callId);
  const [pending, start] = useTransition();
  if (output.mode === "refused") return <CardShell title="Stage change not suggested" icon={<Lock />}><p className="text-muted">{output.error}</p></CardShell>;
  const s = output.suggestion;
  const blocking = s.gateIssues.filter((g) => g.includes("is required"));
  return (
    <CardShell title="Suggested stage change" icon={<ArrowRight />}>
      <p>
        <Link href={`/deals/${s.dealId}`} className="font-medium text-fg underline decoration-border-strong underline-offset-2">
          {s.dealName}
        </Link>
        <span className="text-muted"> · {s.pipelineKey}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <Badge>{s.fromStage.name}</Badge>
        <ArrowRight className="size-3.5 text-muted" aria-label="to" />
        <Badge className="border-white text-fg">{s.toStage.name}</Badge>
      </p>
      <p className="mt-2 text-secondary">{s.reason}</p>
      {s.gateIssues.length ? (
        <ul className="mt-2 space-y-1">
          {s.gateIssues.map((g) => (
            <li key={g}>
              <StatusBadge status={g.includes("is required") ? "serious" : "warning"} label={g} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {applied ? (
          <StatusBadge status="good" label={applied === "pending_approval" ? "Sent for approval" : applied === "dismissed" ? "Dismissed" : "Applied"} />
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={pending || blocking.length > 0}
              title={blocking.length ? "Fill the required fields on the deal first" : undefined}
              onClick={() =>
                start(async () => {
                  const r = await applyCopilotStageChange({ dealId: s.dealId, stageKey: s.toStage.key, reason: s.reason });
                  if (r.ok) {
                    setAppliedState(r.data.status);
                    toast.success(r.data.status === "applied" ? `Moved to ${r.data.stageName}` : `Approval requested for ${r.data.stageName}`);
                  } else toast.error(r.error);
                })
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : <Check />} {s.requiresApproval ? "Request approval" : "Apply stage change"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAppliedState("dismissed")}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </CardShell>
  );
}

/* ───────────── email draft card ───────────── */

export function DraftCard({ output }: { output: EmailDraft | { error: string } }) {
  const [body, setBody] = useState("error" in output ? "" : output.body);
  const [copied, setCopied] = useState(false);
  if ("error" in output) return <CardShell title="Draft not created" icon={<Lock />}><p className="text-muted">{output.error}</p></CardShell>;
  const hits = output.claims.hits.filter((h) => body.toLowerCase().includes(h.match.toLowerCase()) || output.subject.toLowerCase().includes(h.match.toLowerCase()));
  const verdict = hits.length === 0 ? "pass" : output.claims.blocked ? "blocked" : "flagged";
  return (
    <CardShell
      title={
        <span className="flex w-full flex-wrap items-center justify-between gap-2">
          <span>Email draft · never sent automatically</span>
          <StatusBadge status={verdict === "pass" ? "good" : verdict === "blocked" ? "critical" : "warning"} label={verdict === "pass" ? "Claims check passed" : verdict === "blocked" ? "Blocked claims" : "Claims flagged"} />
        </span>
      }
      icon={<ShieldCheck />}
    >
      <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
        <dt className="text-muted">To</dt>
        <dd className="break-all text-body">{output.to}</dd>
        <dt className="text-muted">Subject</dt>
        <dd className="text-body">{output.subject}</dd>
      </dl>
      <label className="sr-only" htmlFor={`draft-${output.subject}`}>
        Draft body
      </label>
      <textarea
        id={`draft-${output.subject}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(14, Math.max(5, body.split("\n").length + 1))}
        className="mt-2 w-full resize-y rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] leading-5 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      />
      {hits.length ? (
        <div className="mt-2">
          <ClaimHits
            hits={hits}
            onUseAlternative={(h) => h.alternative && setBody((b) => b.replace(new RegExp(h.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), h.alternative!))}
          />
        </div>
      ) : null}
      {output.mnpiWarnings.length || output.contactWarnings.length ? (
        <ul className="mt-2 space-y-1">
          {[...output.mnpiWarnings.map((w) => `MNPI: ${w}`), ...output.contactWarnings].map((w) => (
            <li key={w}>
              <StatusBadge status="serious" label={w} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`Subject: ${output.subject}\n\n${body}`);
              setCopied(true);
              toast.success("Draft copied");
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error("Clipboard unavailable");
            }
          }}
        >
          {copied ? <Check /> : <ClipboardCopy />} Copy draft
        </Button>
        <span className="text-[11px] text-muted">{output.engine === "heuristic" ? "Template draft (AI unavailable)" : "Review before sending from your mail client"}</span>
      </div>
    </CardShell>
  );
}

/* ───────────── meeting brief card ───────────── */

export function BriefCard({ output }: { output: MeetingBrief | { error: string } }) {
  const [open, setOpen] = useState(false);
  if ("error" in output) return <CardShell title="Meeting brief" icon={<Lock />}><p className="text-muted">{output.error}</p></CardShell>;
  return (
    <CardShell
      title={
        <span className="flex w-full items-center justify-between gap-2">
          <span>Meeting brief</span>
          {output.stored ? <Badge>Saved to meeting</Badge> : null}
        </span>
      }
      icon={<Sparkles />}
    >
      <div className={cn("relative overflow-hidden", !open && "max-h-56")}>
        <Markdown text={output.markdown} />
        {!open ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-1 to-transparent" /> : null}
      </div>
      <Button size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Show less" : "Show full brief"}
      </Button>
    </CardShell>
  );
}

/* ───────────── pipeline report card ───────────── */

export function ReportCard({ report }: { report: PipelineReport }) {
  const showMuu = report.rows.some((r) => r.muu > 0);
  const showLive = report.rows.some((r) => r.liveActivations > 0);
  return (
    <CardShell title={`Pipeline · ${report.pipelineKey ?? "all pipelines"} · by ${report.groupBy} · ${report.basis.toUpperCase()}`} icon={<FileSearch />}>
      <p className="mb-2 text-[12px] text-muted">{report.basisLabel}</p>
      {report.rows.length === 0 ? (
        <p className="text-muted">No deals you can see match this report.</p>
      ) : (
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="table-sticky-first w-full text-left text-[12px] tabular">
            <thead>
              <tr className="border-b border-border-strong text-muted">
                <th className="py-1 pr-3 font-medium">{report.groupBy === "owner" ? "Owner" : report.groupBy === "category" ? "Category" : "Stage"}</th>
                <th className="py-1 pr-3 text-right font-medium">Deals</th>
                {showMuu ? <th className="py-1 pr-3 text-right font-medium">MUU</th> : null}
                <th className="py-1 pr-3 text-right font-medium">{report.basis === "gross" ? "Gross" : "Net"}</th>
                <th className="py-1 pr-3 text-right font-medium">Weighted</th>
                {showLive ? <th className="py-1 text-right font-medium">Live</th> : null}
              </tr>
            </thead>
            <tbody>
              {[...report.rows, report.totals].map((r, i) => (
                <tr key={`${r.group}-${i}`} className={cn("border-b border-border", i === report.rows.length && "font-medium text-fg")}>
                  <td className="whitespace-nowrap py-1 pr-3">{r.group}</td>
                  <td className="py-1 pr-3 text-right">{fmtNumber(r.deals)}</td>
                  {showMuu ? <td className="py-1 pr-3 text-right">{fmtNumber(r.muu, { compact: true })}</td> : null}
                  <td className="py-1 pr-3 text-right">{fmtUsd(r.valueUsd, { compact: true })}</td>
                  <td className="py-1 pr-3 text-right">{fmtUsd(r.weightedUsd, { compact: true })}</td>
                  {showLive ? <td className="py-1 text-right">{fmtNumber(r.liveActivations)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.notes.length ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
          {report.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      ) : null}
    </CardShell>
  );
}

/* ───────────── dispatcher ───────────── */

export function ToolPart({ name, callId, state, input, output, errorText }: { name: string; callId: string; state: string; input: unknown; output: unknown; errorText?: string }) {
  const done = state === "output-available";
  if (done && output && typeof output === "object") {
    const o = output as Obj;
    if (name === "create_task" && "mode" in o) return <TaskCard callId={callId} output={output as CreateTaskOutput} />;
    if (name === "suggest_stage_change" && "mode" in o) return <StageCard callId={callId} output={output as StageSuggestionOutput} />;
    if (name === "draft_email" && ("body" in o || "error" in o)) return <DraftCard output={output as EmailDraft} />;
    if (name === "meeting_prep" && ("markdown" in o || "error" in o)) return <BriefCard output={output as MeetingBrief} />;
    if (name === "pipeline_report" && "rows" in o) return <ReportCard report={output as PipelineReport} />;
  }
  return <ToolChip name={name} state={state} input={input} output={output} errorText={errorText} />;
}
