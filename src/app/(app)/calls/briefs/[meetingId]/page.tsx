import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { getMeetingBriefForUser } from "@/lib/briefs/meeting";
import { formatInTz } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { PrepareBriefButton } from "@/components/briefs/prepare-brief-button";
import { RequestHelpButton } from "@/components/help/request-help";

export const metadata = { title: "Meeting brief" };

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

/** V2 A5: the auto-prepared pre-meeting brief (owner only). */
export default async function MeetingBriefPage({ params }: PageProps<"/calls/briefs/[meetingId]">) {
  const user = await requireUser();
  const { meetingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) notFound();
  const data = await getMeetingBriefForUser(user, meetingId);
  if (!data) notFound();
  const { meeting: m, brief, upcoming, external } = data;
  const tz = user.timezone;
  const date = (iso: string | null) => (iso ? formatInTz(iso, tz, "date") : "—");
  // Re-check deal visibility at render time (access lists can change after the brief was built).
  const deal = brief?.deal && (await getAccessibleDeal(user, brief.deal.id, "view")) ? brief.deal : null;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/calls" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> Calls
      </Link>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Meeting brief</p>
          <h1 className="font-display text-[28px] font-medium leading-9 text-fg">{m.title ?? "Untitled meeting"}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-secondary">
            <span className="tabular">{m.startsAt ? formatInTz(m.startsAt, tz, "datetime") : "No time"}</span>
            {upcoming && m.startsAt ? (
              <>
                <span aria-hidden className="text-muted">·</span>
                <span className="text-muted">
                  starts <RelativeTime value={m.startsAt} />
                </span>
              </>
            ) : null}
            {brief?.account ? (
              <>
                <span aria-hidden className="text-muted">·</span>
                <Link href={`/accounts/${brief.account.id}`} className="hover:text-fg">
                  {brief.account.name}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RequestHelpButton meetingId={m.id} dealId={m.dealId ?? undefined} />
          {brief ? <PrepareBriefButton meetingId={m.id} refresh variant="secondary" /> : null}
        </div>
      </header>

      {!brief && !external ? (
        <EmptyState title="Internal meeting" description="Everyone on this invite is from your team, so there's nothing to brief. Briefs are prepared for meetings with people outside the company." />
      ) : !brief ? (
        <EmptyState
          title="No brief yet"
          description="Briefs are prepared automatically about 45 minutes before external meetings linked to an account or deal (and with the morning sync). Prepare one now if you want it earlier."
          action={<PrepareBriefButton meetingId={m.id} />}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <Card className="px-5 py-5">
              <Section title="Talking points">
                <ol className="space-y-3">
                  {brief.talkingPoints.map((p, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="font-display text-xl leading-6 text-muted tabular">{i + 1}</span>
                      <span className="text-[15px] leading-6 text-body">{p}</span>
                    </li>
                  ))}
                </ol>
              </Section>
            </Card>

            {brief.risks.length ? (
              <Card className="px-5 py-4">
                <Section title="Risks">
                  {/* POL-06: the section header already says "Risks" — no per-item badge */}
                  <ul className="list-disc space-y-1.5 pl-4 text-sm text-body marker:text-warning">
                    {brief.risks.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </Section>
              </Card>
            ) : null}

            <Card className="grid gap-5 px-5 py-4 sm:grid-cols-2">
              <Section title="We owe">
                {brief.commitments.ours.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {brief.commitments.ours.map((t, i) => (
                      <li key={i} className="text-body">
                        {t.title}
                        {t.due ? <span className={t.overdue ? "ml-1 text-xs text-critical" : "ml-1 text-xs text-muted"}>· {t.overdue ? "overdue" : `due ${date(t.due)}`}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">Nothing open.</p>
                )}
              </Section>
              <Section title="They owe">
                {brief.commitments.theirs.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {brief.commitments.theirs.map((t, i) => (
                      <li key={i} className="text-body">
                        {t.title.replace(/^Waiting on [^:]+:\s*/i, "")}
                        {t.due ? <span className="ml-1 text-xs text-muted">· due {date(t.due)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">Nothing open.</p>
                )}
              </Section>
            </Card>

            {brief.lastCall ? (
              <Card className="px-5 py-4">
                <Section title={`Last call${brief.lastCall.at ? ` · ${date(brief.lastCall.at)}` : ""}`}>
                  {brief.lastCall.highlights.length ? (
                    <ul className="list-disc space-y-1 pl-4 text-sm text-body">
                      {brief.lastCall.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">No highlights recorded.</p>
                  )}
                  <Link href={`/calls/${brief.lastCall.id}`} className="mt-2 inline-block text-xs text-secondary hover:text-fg hover:underline">
                    Open the call
                  </Link>
                </Section>
              </Card>
            ) : null}
          </div>

          <aside className="space-y-6">
            {deal ? (
              <Card className="px-5 py-4">
                <Section title="Deal">
                  <Link href={`/deals/${deal.id}`} className="font-display text-lg leading-6 text-fg hover:underline">
                    {deal.name}
                  </Link>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Stage</dt>
                      <dd className="text-right text-body">{deal.stage}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Health</dt>
                      <dd className="tabular text-body">{deal.health ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Expected close</dt>
                      <dd className="tabular text-body">{date(deal.expectedCloseDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Next step</dt>
                      <dd className="mt-0.5 text-body">
                        {deal.nextStep ?? <span className="text-warning">None</span>}
                        {deal.nextStepDueAt ? <span className="ml-1 text-xs text-muted">· due {date(deal.nextStepDueAt)}</span> : null}
                      </dd>
                    </div>
                  </dl>
                </Section>
              </Card>
            ) : null}
            <Card className="px-5 py-4">
              <Section title={`Attendees (${brief.attendees.length})`}>
                <ul className="space-y-2.5">
                  {brief.attendees.map((a) => (
                    <li key={a.email} className="min-w-0 text-sm">
                      <p className="truncate text-body">{a.name ?? a.email}</p>
                      <p className="truncate text-xs text-muted">
                        {[a.title, a.name ? a.email : null].filter(Boolean).join(" · ") || "Not in the CRM yet"}
                        {a.lastTouch ? ` · last touch ${date(a.lastTouch)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>
            </Card>
            <p className="text-[11px] text-muted">
              {brief.engine.startsWith("ai:") ? "Talking points by AI" : "Prepared from your CRM data"} · updated <RelativeTime value={brief.generatedAt} />
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
