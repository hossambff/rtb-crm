import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, UserPlus } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EnrollDialog } from "@/components/sequences/enroll-dialog";
import { EnrollmentsTable } from "@/components/sequences/enrollments-table";
import { SequenceBuilder } from "@/components/sequences/sequence-builder";
import { OlderVersionNotice, ResumePausedButton, SequenceMenu } from "@/components/sequences/sequence-controls";
import { MetricsRow, StepStrip } from "@/components/sequences/sequence-views";
import { requireUser } from "@/lib/rbac/server";
import { validateSequence } from "@/lib/sequences/core";
import { getSequence, listEnrollments, pipelineOptions } from "@/lib/sequences/queries";
import { cn } from "@/lib/utils";

const load = cache(async (id: string) => getSequence(await requireUser(), id));

export async function generateMetadata({ params }: PageProps<"/sequences/[id]">) {
  const d = await load((await params).id);
  return { title: d?.sequence.name ?? "Sequence" };
}

export default async function SequencePage(props: PageProps<"/sequences/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  const data = await load(id);
  if (!data) notFound();
  const sp = await props.searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const tab = one("tab") === "steps" ? "steps" : "people";
  const attention = one("view") === "attention";
  const { sequence: q, metrics, canEdit } = data;
  const problems = validateSequence(q.steps);
  const [enrollments, pipelines] = await Promise.all([tab === "people" ? listEnrollments(user, { sequenceId: q.id, attention, limit: 300 }) : Promise.resolve([]), tab === "steps" ? pipelineOptions() : Promise.resolve([])]);
  // "Resume" only lifts system pauses (QA MAJ-12); people paused by hand stay paused
  const myPaused = enrollments.filter((e) => e.status === "paused" && e.senderId === user.id && e.systemPaused).length;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-xs text-muted">
        <Link href="/sequences" className="-my-2 shrink-0 py-2 hover:text-fg">
          Sequences
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="min-w-0 truncate text-secondary">{q.name}</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words font-display text-2xl font-medium leading-8 text-fg sm:text-[28px] sm:leading-9">{q.name}</h1>
            {problems.length ? <StatusBadge status="warning" label="Needs edits" /> : q.active ? <StatusBadge status="good" label="Live" /> : <StatusBadge status="info" label="Paused" />}
          </div>
          <p className="mt-1 text-sm text-muted">
            {data.ownerName ? `Owner ${data.ownerName}` : "Team sequence"} · {q.shared ? "shared" : "private"} · cap {q.dailyCap}/day per mailbox
          </p>
          <StepStrip steps={q.steps} className="mt-3" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {q.active && !problems.length ? (
            <EnrollDialog
              sequenceId={q.id}
              sequenceName={q.name}
              source="sequence_page"
              trigger={
                <Button variant="primary" size="sm">
                  <UserPlus aria-hidden /> Enroll people
                </Button>
              }
            />
          ) : null}
          <SequenceMenu id={q.id} name={q.name} active={q.active} canEdit={canEdit} />
        </div>
      </header>

      <div className="mb-6 rounded-lg border border-border bg-surface-1 px-4 py-4 sm:px-5">
        <MetricsRow m={metrics} />
      </div>

      <OlderVersionNotice sequenceId={q.id} version={q.version} enrollments={data.olderVersion.enrollments} senders={data.olderVersion.senders} canEdit={canEdit} />

      <nav aria-label="Sequence sections" className="mb-5 flex gap-1 border-b border-border">
        {(
          [
            ["people", `People${metrics.enrolled ? ` · ${metrics.enrolled}` : ""}`],
            ["steps", canEdit ? "Steps & rules" : "Steps"],
          ] as const
        ).map(([k, l]) => (
          <Link
            key={k}
            href={k === "people" ? `/sequences/${q.id}` : `/sequences/${q.id}?tab=steps`}
            aria-current={tab === k ? "page" : undefined}
            className={cn("-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted transition-colors duration-150 hover:text-fg", tab === k && "border-white text-fg")}
          >
            {l}
          </Link>
        ))}
      </nav>

      {tab === "steps" ? (
        <SequenceBuilder
          initial={{ id: q.id, name: q.name, description: q.description, steps: q.steps, exitOn: q.exitOn, dailyCap: q.dailyCap, shared: q.shared, pipelineKeys: q.pipelineKeys }}
          canEdit={canEdit}
          activeEnrollments={metrics.active}
          pipelines={pipelines}
        />
      ) : (
        <>
          {attention || myPaused ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              {attention ? (
                <>
                  <span className="text-secondary">Showing failed and paused only.</span>
                  <Link href={`/sequences/${q.id}`} className="text-fg underline underline-offset-2">
                    Show everyone
                  </Link>
                </>
              ) : null}
              <span className="ml-auto">
                <ResumePausedButton sequenceId={q.id} count={myPaused} />
              </span>
            </div>
          ) : null}
          <EnrollmentsTable rows={enrollments} emptyText={problems.length ? "Fix the steps first, then enroll people." : "Enroll people from here, a contact, deal or account page, the deals list, or a Lead Scout batch."} />
        </>
      )}
    </div>
  );
}
