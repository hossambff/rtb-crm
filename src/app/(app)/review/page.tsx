import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { approvalHref } from "@/lib/slack/core";
import { exceptionCounts } from "@/lib/review/core";
import { buildExceptionList, listMySessions, reviewScopeOptions, sanitizeScope, SESSION_LIMIT } from "@/lib/review/queries";
import { formatInTz } from "@/lib/time";
import { PageHeader } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/badge";
import { ScopePicker } from "@/components/review/scope-picker";
import { scopeToQuery } from "@/lib/review/scope";
import { StartReviewButton } from "@/components/review/start-review";
import { ExceptionList, ExceptionSummary } from "@/components/review/exception-list";
import { Kbd } from "@/components/team/kbd";

export const metadata = { title: "Pipeline review" };

const list = (v: string | string[] | undefined) => (typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

export default async function ReviewPage({ searchParams }: PageProps<"/review">) {
  const user = await requireUser();
  const sp = await searchParams;
  const options = await reviewScopeOptions(user);
  if (options.analyticsScope === "none") forbidden(); // layout already answered 403 (QA C5); defence in depth
  const scope = sanitizeScope({ pipelineKeys: list(sp.p), teamId: typeof sp.team === "string" ? sp.team : null, ownerIds: list(sp.o) }, options);
  const [{ rows, scanned, truncated, bulkOverrides }, sessions] = await Promise.all([buildExceptionList(user, scope), listMySessions(user).catch(() => [])]);
  const counts = exceptionCounts(rows);
  const active = sessions.find((s) => !s.endedAt);
  const tz = user.timezone;

  return (
    <div>
      <PageHeader
        title="Pipeline review"
        description={
          <>
            Walk the exceptions, decide, move on. One deal at a time — <Kbd>1</Kbd>–<Kbd>5</Kbd> to decide, <Kbd>→</Kbd> to move.
          </>
        }
      />
      <div className="space-y-5">
        {active ? (
          <Link href={`/review/${active.id}`} className="group flex items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-3 text-sm transition-colors duration-150 hover:bg-surface-3">
            <span className="min-w-0 break-words">
              <span className="text-fg">Resume “{active.title}”</span>
              <span className="text-muted"> · {active.decisionCount} decided of {active.dealCount}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-secondary transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
          </Link>
        ) : null}

        <ScopePicker key={scopeToQuery(scope)} options={options} scope={scope} />

        {bulkOverrides.map((b) => (
          // QA MAJ-21: one bulk override = one decision, made in Approvals (not N review rows).
          <Link
            key={b.approvalId}
            href={approvalHref(b.approvalId)}
            className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3 text-sm transition-colors duration-150 hover:bg-surface-2"
          >
            <span className="min-w-0">
              <span className="text-fg">Bulk probability override</span>
              <span className="text-muted">
                {" "}
                · {b.deals} deal{b.deals === 1 ? "" : "s"} in this scope · one decision in Approvals
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-secondary transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
          </Link>
        ))}

        {rows.length ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm text-secondary">
                  <span className="text-fg">{rows.length}</span> of {scanned} open deal{scanned === 1 ? "" : "s"} need a decision
                  {rows.length > SESSION_LIMIT ? ` — the top ${SESSION_LIMIT} go into the walk-through` : ""}.
                </p>
                <div className="mt-3">
                  <ExceptionSummary counts={counts} />
                </div>
              </div>
              <StartReviewButton scope={scope} count={rows.length} limit={SESSION_LIMIT} />
            </div>
            {truncated ? <p className="text-xs text-muted">Very large scope: only the first 3,000 candidate deals were checked. Narrow the motions or people for a complete list.</p> : null}
            <ExceptionList rows={rows} limit={SESSION_LIMIT} />
          </>
        ) : (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
            <span className="mb-4 inline-flex size-12 items-center justify-center rounded-full border border-border-strong" aria-hidden>
              <Check className="size-5 text-good" />
            </span>
            <p className="font-display text-lg text-fg">Nothing needs a decision</p>
            <p className="mt-1 max-w-sm text-sm text-muted">
              {scanned
                ? `All ${scanned} open deals in this scope have a next step, a live close date and healthy momentum.`
                : "No open deals in this scope — widen it above (add motions or people) to review more."}
            </p>
          </div>
        )}

        {sessions.length ? (
          <section aria-labelledby="past-reviews">
            <h2 id="past-reviews" className="mb-2 font-display text-lg text-fg">
              Your reviews
            </h2>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link href={`/review/${s.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 hover:bg-surface-2">
                    <span className="min-w-0 flex-1 truncate text-body">{s.title}</span>
                    <span className="text-xs text-muted tabular">
                      {s.decisionCount} decision{s.decisionCount === 1 ? "" : "s"} · {s.dealCount} deals · {formatInTz(s.startedAt, tz, "short")}
                    </span>
                    {s.endedAt ? <StatusBadge status="good" label="Done" /> : <StatusBadge status="progress" label="In progress" />}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
