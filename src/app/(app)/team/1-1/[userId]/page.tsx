import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { getOneOnOneBrief, pastOneOnOnes, prepTarget, storedOneOnOne } from "@/lib/briefs/one-on-one";
import { isoWeekLabel, isValidIsoWeek } from "@/lib/team/week";
import { ROLE_LABELS, type Role } from "@/lib/rbac/model";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { BriefView } from "@/components/one-on-one/brief-view";
import { RefreshBriefButton } from "@/components/one-on-one/refresh-button";
import { cn } from "@/lib/utils";
import { ScrollStrip } from "@/components/ui/scroll-strip";

export const metadata = { title: "1:1 prep" };

export default async function OneOnOnePage({ params, searchParams }: PageProps<"/team/1-1/[userId]">) {
  const user = await requireUser();
  const { userId } = await params;
  const sp = await searchParams;
  if (!/^[\w-]{1,100}$/.test(userId)) notFound();
  const rep = await prepTarget(user, userId);
  if (!rep) notFound(); // also hides whether the person exists
  const weekParam = typeof sp.week === "string" && isValidIsoWeek(sp.week) ? sp.week : null;

  const [current, past] = await Promise.all([getOneOnOneBrief(user, userId), pastOneOnOnes(user, userId)]);
  const viewing = weekParam && current && weekParam !== current.periodKey ? await storedOneOnOne(user, userId, weekParam) : current;
  const isCurrent = viewing?.periodKey === current?.periodKey;

  return (
    <div>
      <Link href="/team?tab=1-1" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> 1:1 prep
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={rep.name} src={rep.image} size={44} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-[28px] font-medium leading-9 text-fg">1:1 with {rep.name.split(/\s+/)[0]}</h1>
            <p className="text-sm text-muted">
              {rep.title ?? ROLE_LABELS[rep.role as Role] ?? rep.role}
              {viewing ? (
                <>
                  {" · "}
                  {isoWeekLabel(viewing.periodKey)}
                  {" · generated "}
                  <RelativeTime value={viewing.createdAt} />
                </>
              ) : null}
            </p>
          </div>
        </div>
        {isCurrent ? <RefreshBriefButton repId={rep.id} /> : null}
      </div>

      {past.length > 1 ? (
        <ScrollStrip as="nav" aria-label="Earlier weeks" className="-mx-4 mb-5 px-4 md:mx-0 md:px-0">
          <ul className="flex min-w-max gap-1.5">
            {past.map((p) => {
              const on = p.periodKey === viewing?.periodKey;
              return (
                <li key={p.periodKey}>
                  <Link
                    href={`/team/1-1/${rep.id}${p.periodKey === current?.periodKey ? "" : `?week=${p.periodKey}`}`}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "inline-flex h-7 items-center rounded-full border px-3 text-xs transition-colors duration-150",
                      on ? "border-white bg-white text-black" : "border-border text-secondary hover:text-fg",
                    )}
                  >
                    {p.periodKey === current?.periodKey ? "This week" : p.periodKey.replace("-W", " · W")}
                  </Link>
                </li>
              );
            })}
          </ul>
        </ScrollStrip>
      ) : null}

      {viewing ? (
        <BriefView content={viewing.content} engine={viewing.engine} tz={user.timezone} />
      ) : (
        <EmptyState title="No brief for that week" description="Briefs are kept for weeks you opened them." action={<Link href={`/team/1-1/${rep.id}`} className="text-sm text-fg underline-offset-4 hover:underline">This week&apos;s brief</Link>} />
      )}
    </div>
  );
}
