import Link from "next/link";
import { Upload } from "lucide-react";
import { requireUser, scopeFor } from "@/lib/rbac/server";
import { redirect } from "next/navigation";
import { listTranscripts, meetingLinkTarget, meetingsMissingNotes } from "@/lib/transcripts/queries";
import { getConnection } from "@/lib/integrations/store";
import { fmtDate, fmtRelative } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { SOURCE_LABELS, TranscriptStatus } from "@/components/calls/transcript-status";
import { AutoRefresh, GranolaSyncButton } from "@/components/calls/call-controls";
import { upcomingMeetingsWithBriefs } from "@/lib/briefs/meeting";
import { briefHref } from "@/lib/briefs/meeting-core";
import { formatInTz } from "@/lib/time";
import { RequestHelpButton } from "@/components/help/request-help";

export const metadata = { title: "Calls" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function CallsPage({ searchParams }: PageProps<"/calls">) {
  const user = await requireUser();
  const sp = await searchParams;
  const meetingParam = one(sp.meeting);
  if (meetingParam) {
    const target = await meetingLinkTarget(user, meetingParam);
    if (target) redirect(target);
  }
  const f = { q: one(sp.q)?.slice(0, 100), source: one(sp.source), status: one(sp.status) };
  const [rows, missing, granola, createScope, upcoming] = await Promise.all([
    listTranscripts(user, f),
    meetingsMissingNotes(user),
    getConnection(user.id, "granola"),
    scopeFor(user, "calls", "create"),
    upcomingMeetingsWithBriefs(user, 4),
  ]);
  if (!rows) {
    return (
      <>
        <PageHeader title="Calls" />
        <EmptyState title="No access" description="Your role doesn't include call transcripts. Ask an admin if you need it." />
      </>
    );
  }
  const canCreate = createScope !== "none";
  const granolaOn = Boolean(granola?.secretEncrypted && granola.status !== "revoked");
  const filtered = Boolean(f.q || f.source || f.status);
  const processing = rows.some((r) => r.status === "pending" || r.status === "processing");

  return (
    <div>
      <AutoRefresh active={processing} intervalMs={5000} />
      <PageHeader
        title="Calls"
        description="Transcripts from Granola, Zoom and uploads — summarized, with action items ready to apply."
        actions={
          <>
            {granolaOn ? <GranolaSyncButton /> : null}
            {canCreate ? (
              <Button asChild size="sm" variant="primary">
                <Link href="/calls/upload">
                  <Upload /> Add transcript
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {upcoming.length && !filtered ? (
        <Card className="mb-6">
          <CardHeader>
            <div>
              <CardTitle className="text-base">Coming up</CardTitle>
              <CardDescription>Your next external meetings. Briefs are prepared automatically ~45 minutes before.</CardDescription>
            </div>
          </CardHeader>
          <ul className="divide-y divide-border">
            {upcoming.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-body">{m.title ?? "Untitled meeting"}</span>
                <span className="text-xs text-muted tabular">{m.startsAt ? `${formatInTz(m.startsAt, user.timezone, "short")}, ${formatInTz(m.startsAt, user.timezone, "time")}` : ""}</span>
                <Button asChild size="sm" variant={m.briefId ? "secondary" : "ghost"} className="h-7">
                  <Link href={briefHref(m.id)}>{m.briefId ? "Open brief" : "Brief"}</Link>
                </Button>
                <RequestHelpButton meetingId={m.id} dealId={m.dealId ?? undefined} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {missing.length && canCreate ? (
        <Card className="mb-6">
          <CardHeader>
            <div>
              <CardTitle className="text-base">Meetings without notes</CardTitle>
              <CardDescription>External meetings from the last 7 days with no transcript yet.</CardDescription>
            </div>
          </CardHeader>
          <ul className="divide-y divide-border">
            {missing.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-body">{m.title ?? "Untitled meeting"}</span>
                <span className="text-xs text-muted">ended {fmtRelative(m.endsAt)}</span>
                <Button asChild size="sm" variant="secondary" className="h-7">
                  <Link href={`/calls/upload?meetingId=${m.id}${m.dealId ? `&dealId=${m.dealId}` : ""}`}>Upload transcript</Link>
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <form action="/calls" role="search" className="mb-4 flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={f.q ?? ""}
          placeholder="Search titles and transcripts"
          aria-label="Search calls"
          className="h-8 min-w-52 flex-1 rounded-md border border-border bg-surface-3/40 px-3 text-sm text-body placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:max-w-sm"
        />
        <select name="source" defaultValue={f.source ?? ""} aria-label="Source" className="h-8 rounded-md border border-border bg-surface-2 px-2 text-xs text-body">
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={f.status ?? ""} aria-label="Status" className="h-8 rounded-md border border-border bg-surface-2 px-2 text-xs text-body">
          <option value="">Any status</option>
          <option value="ready">Analyzed</option>
          <option value="processing">Analyzing</option>
          <option value="pending">Queued</option>
          <option value="failed">Failed</option>
        </select>
        <button type="submit" className="h-8 rounded-md border border-border-strong px-3 text-xs text-fg hover:bg-surface-2">
          Apply
        </button>
        {filtered ? (
          <Link href="/calls" className="text-xs text-muted hover:text-fg">
            Clear
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState title="No calls match" description="Try a different search or filter." />
        ) : (
          <EmptyState
            title="No calls yet"
            description={
              granolaOn
                ? "Granola is connected — new notes arrive automatically. You can also upload a transcript (.txt, .vtt, .srt, .md) or paste one."
                : "Add your Granola API key in Settings to import calls automatically, or upload/paste a transcript. Zoom cloud recordings arrive once an admin connects Zoom."
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {canCreate ? (
                  <Button asChild size="sm" variant="primary">
                    <Link href="/calls/upload">Add transcript</Link>
                  </Button>
                ) : null}
                {!granolaOn ? (
                  <Button asChild size="sm" variant="secondary">
                    <Link href="/settings#connections">Connect Granola</Link>
                  </Button>
                ) : null}
              </div>
            }
          />
        )
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full sm:min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th scope="col" className="px-5 py-2.5 font-medium">Call</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Date</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Source</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Deal</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="hidden px-3 py-2.5 font-medium 2xl:table-cell">Engine</th>
                <th scope="col" className="hidden px-5 py-2.5 font-medium xl:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/40">
                  <td className="max-w-72 px-5 py-2.5">
                    <Link href={`/calls/${r.id}`} className="block truncate text-fg hover:underline">
                      {r.title ?? "Untitled call"}
                    </Link>
                    {r.accountName ? <span className="text-xs text-muted">{r.accountName}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-secondary tabular">
                    {fmtDate(r.occurredAt ?? r.createdAt, "d MMM yyyy")}
                    {r.durationMin ? <span className="ml-1 text-xs text-muted">· {r.durationMin}m</span> : null}
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <Badge>{SOURCE_LABELS[r.source] ?? r.source}</Badge>
                  </td>
                  <td className="hidden max-w-48 truncate px-3 py-2.5 text-secondary sm:table-cell">
                    {r.dealId ? (r.dealName ? <Link href={`/deals/${r.dealId}`} className="hover:text-fg">{r.dealName}</Link> : "Linked") : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <TranscriptStatus status={r.status} />
                      {r.appliedAt ? <Badge>Applied</Badge> : null}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-muted 2xl:table-cell">{r.analysisEngine ? (r.analysisEngine === "heuristic" ? "Heuristic" : "AI") : "—"}</td>
                  <td className="hidden px-5 py-2.5 text-xs text-secondary xl:table-cell">{r.uploadedBy === user.id ? "You" : (r.uploaderName ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
