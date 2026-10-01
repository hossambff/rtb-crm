import Link from "next/link";
import { CalendarClock, Mail, MessageSquare, NotebookPen, PhoneCall } from "lucide-react";
import { Avatar } from "@/components/ui/misc";
import type { AppUser } from "@/lib/rbac/server";
import { getAccountTouchTimeline, type TouchKind } from "@/lib/deals/collisions";
import { dayPhrase, latestPerPerson, type RecentTouch } from "@/lib/deals/collisions-core";
import { fmtDate } from "@/lib/format";

const KIND: Record<TouchKind, { icon: typeof Mail; word: string }> = {
  email: { icon: Mail, word: "Email" },
  call: { icon: PhoneCall, word: "Call" },
  meeting: { icon: CalendarClock, word: "Meeting" },
  linkedin: { icon: MessageSquare, word: "LinkedIn" },
  note: { icon: NotebookPen, word: "Note" },
};

/**
 * "Who's talking to them" (V2 §C4) — unified touch timeline for an account page: everyone's emails, calls, meetings
 * (incl. upcoming) over the last 90 days, newest first. Who / what kind / when / which deal (only deals the viewer can
 * see) — never subjects or bodies. Restricted deals and private threads are excluded upstream.
 * Usage (server component): <WhoIsTalking user={user} accountId={account.id} />
 */
export async function WhoIsTalking({ user, accountId, days = 90 }: { user: AppUser; accountId: string; days?: number }) {
  const rows = await getAccountTouchTimeline(user, accountId, { days, limit: 40 });
  const now = new Date();
  const people = latestPerPerson(
    rows.map<RecentTouch>((r) => ({ userId: r.userId, userName: r.userName, userImage: r.userImage, kind: r.kind, at: r.at, count: 1 })),
  );
  return (
    <section aria-labelledby="who-talking-h" className="rounded-lg border border-border bg-surface-1">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id="who-talking-h" className="font-display text-base text-fg">
          Who&apos;s talking to them
        </h2>
        <span className="text-[11px] text-muted">last {days} days</span>
      </div>
      {!rows.length ? (
        <p className="px-4 py-4 text-sm text-muted">No logged emails, calls or meetings with this account in the last {days} days.</p>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <ul className="flex flex-wrap gap-2" aria-label="People in touch">
            {people.map((p) => (
              <li key={p.userId} className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-0.5 pr-2.5 text-[12px]">
                <Avatar name={p.userName} src={p.userImage} size={20} />
                <span className="text-body">{p.userName.split(/\s+/)[0]}</span>
                <span className="text-muted tabular">
                  {p.total} · {dayPhrase(new Date(p.at), now)}
                </span>
              </li>
            ))}
          </ul>
          <ol className="space-y-1.5">
            {rows.slice(0, 15).map((r) => {
              const k = KIND[r.kind];
              const Icon = k.icon;
              const future = new Date(r.at).getTime() > now.getTime();
              return (
                <li key={r.id} className="flex min-w-0 items-center gap-2 text-[12px]">
                  <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="shrink-0 text-body">{r.userName}</span>
                  <span className="text-muted">{future ? `${k.word.toLowerCase()} planned` : k.word.toLowerCase()}</span>
                  {r.dealId && r.dealName ? (
                    <Link href={`/deals/${r.dealId}`} className="min-w-0 truncate text-secondary hover:text-fg hover:underline">
                      {r.dealName}
                    </Link>
                  ) : null}
                  <time dateTime={r.at} className="ml-auto shrink-0 text-muted tabular">
                    {fmtDate(r.at, "d MMM")}
                  </time>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
