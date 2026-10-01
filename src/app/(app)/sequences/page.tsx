import Link from "next/link";
import { MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { EnrollmentsTable } from "@/components/sequences/enrollments-table";
import { NewSequenceButton, ResumePausedButton } from "@/components/sequences/sequence-controls";
import { SequenceCard } from "@/components/sequences/sequence-views";
import { requireUser } from "@/lib/rbac/server";
import { GMAIL_CONNECT_HREF } from "@/lib/sequences/access";
import { attentionEnrollments, enrollReadiness, listSequences } from "@/lib/sequences/queries";
import { cn } from "@/lib/utils";

export const metadata = { title: "Sequences" };

export default async function SequencesPage(props: PageProps<"/sequences">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const view = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === "attention" ? "attention" : "all";
  const filter = (Array.isArray(sp.f) ? sp.f[0] : sp.f) === "mine" ? "mine" : "all";
  const [rows, attention, ready] = await Promise.all([listSequences(user), attentionEnrollments(user), enrollReadiness(user)]);
  const shown = filter === "mine" ? rows.filter((r) => r.mine) : rows;
  const pausedCount = attention.filter((a) => a.status === "paused").length;

  return (
    <>
      <PageHeader
        title="Sequences"
        description="1:1 cadences from your own Gmail, inside your working hours. Anyone who replies, books a meeting or opts out leaves automatically."
        actions={<NewSequenceButton />}
      />

      {!ready.gmailReady ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-surface-1 px-4 py-3 text-sm">
          <MailWarning className="size-4 text-warning" aria-hidden />
          <span className="flex-1 text-body">Connect your Gmail (read + send) to enroll people — sequences never send from a shared address.</span>
          <Button asChild size="sm">
            <Link href={GMAIL_CONNECT_HREF}>Connect Gmail</Link>
          </Button>
        </div>
      ) : null}

      {attention.length ? (
        <section aria-labelledby="attention-h" className="mb-6 rounded-lg border border-border bg-surface-1">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <h2 id="attention-h" className="font-display text-lg text-fg">
              {attention.length} need{attention.length === 1 ? "s" : ""} you
            </h2>
            <span className="text-xs text-muted">Failed after 3 tries, or paused (e.g. Gmail disconnected).</span>
            <span className="ml-auto flex gap-2">
              <ResumePausedButton count={pausedCount} />
              {view !== "attention" ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href="/sequences?view=attention">Review</Link>
                </Button>
              ) : null}
            </span>
          </div>
          {view === "attention" ? (
            <div className="p-3">
              <EnrollmentsTable rows={attention} showSequence />
            </div>
          ) : null}
        </section>
      ) : view === "attention" ? (
        <p className="mb-6 rounded-lg border border-border px-4 py-3 text-sm text-secondary">Nothing needs you — every enrollment is running smoothly.</p>
      ) : null}

      {rows.length ? (
        <>
          <nav aria-label="Filter sequences" className="mb-3 flex gap-1 text-sm">
            {(["all", "mine"] as const).map((f) => (
              <Link
                key={f}
                href={f === "all" ? "/sequences" : "/sequences?f=mine"}
                aria-current={filter === f ? "page" : undefined}
                className={cn("rounded-md px-2.5 py-1 text-muted transition-colors duration-150 hover:text-fg", filter === f && "bg-surface-2 text-fg")}
              >
                {f === "all" ? `All (${rows.length})` : `Mine (${rows.filter((r) => r.mine).length})`}
              </Link>
            ))}
          </nav>
          {shown.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((r) => (
                <SequenceCard key={r.id} row={r} />
              ))}
            </div>
          ) : (
            <EmptyState title="You don’t own a sequence yet" description="Duplicate a shared one or start from the template." action={<NewSequenceButton />} />
          )}
        </>
      ) : (
        <EmptyState
          title="No sequences yet"
          description="A sequence is a short cadence — an intro email, a bump, a LinkedIn touch, a last note — that stops itself when someone replies."
          action={<NewSequenceButton />}
        />
      )}
    </>
  );
}
