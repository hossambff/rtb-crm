import { Suspense } from "react";
import { can, requireUser } from "@/lib/rbac/server";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewTaskButton } from "@/components/tasks/new-task-button";
import { GlanceStats, HomeSection, MeetingsList } from "@/components/home/sections";
import { TodayQueue } from "@/components/home/today-queue";
import { AskBar, SuggestionChips } from "@/components/home/ask-bar";
import { ChecklistCard } from "@/components/onboarding-checklist/checklist-card";
import { loadToday, type TodayData } from "@/lib/queue";
import { suggestQuestions } from "@/lib/queue/core";
import { loadChecklist, type ChecklistView } from "@/lib/prefs/checklist";
import { fmtInTz } from "@/lib/tasks/core";
import { localDateKey, toWall } from "@/lib/alerts/time";
import { HOME_PAGE_NAME, QUEUE_NAME } from "@/lib/nav";
import { MailboxBanner } from "@/components/settings/mailbox-banner";
import { needsMailboxConnection } from "@/lib/integrations/queries";
import { scheduleHomeCatchUp } from "@/lib/background";

export const metadata = { title: HOME_PAGE_NAME };
// the in-app catch-up (stale sweep / inbox sync) runs in after() within this budget
export const maxDuration = 300;

function greeting(now: Date, tz: string) {
  const h = toWall(now, tz).getUTCHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function dayOfYear(now: Date, tz: string) {
  const key = localDateKey(now, tz);
  return Math.floor((Date.parse(key) - Date.parse(`${key.slice(0, 4)}-01-01`)) / 86_400_000);
}

/**
 * My Day (V2 §B1). The header and the Ask bar paint first; the Today queue and the side column stream in under
 * <Suspense> (QA MAJ-05), so a slow source never blanks the page.
 */
export default async function HomePage() {
  const user = await requireUser();
  const today = loadToday(user);
  const checklist = loadChecklist(user);
  const needsMailbox = needsMailboxConnection(user).catch(() => false);
  // Errors surface through the Suspense boundaries below; don't let an unobserved rejection crash the request first.
  today.catch(() => undefined);
  const canCopilot = await can(user, "copilot", "use_ai");
  scheduleHomeCatchUp(user.id);
  const tz = user.timezone;
  const now = new Date();
  const first = user.name.split(" ")[0];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${greeting(now, tz)}, ${first}`}
        description={`${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(now)}, ${fmtInTz(now, tz, "date")} — your most urgent things first.`}
        actions={
          <Suspense fallback={null}>
            <NewTask today={today} />
          </Suspense>
        }
      />

      {canCopilot ? (
        <AskBar>
          <Suspense fallback={null}>
            <Suggestions today={today} />
          </Suspense>
        </AskBar>
      ) : null}

      <Suspense fallback={<MainSkeleton />}>
        <TodayMain today={today} checklist={checklist} needsMailbox={needsMailbox} meId={user.id} />
      </Suspense>
    </div>
  );
}

async function NewTask({ today }: { today: Promise<TodayData> }) {
  const d = await today;
  return d.canTasks && d.users.length ? <NewTaskButton users={d.users} /> : null;
}

async function Suggestions({ today }: { today: Promise<TodayData> }) {
  const d = await today;
  return <SuggestionChips suggestions={suggestQuestions(d.signals, dayOfYear(new Date(d.now), d.tz))} />;
}

async function TodayMain({
  today,
  checklist: checklistP,
  needsMailbox: needsMailboxP,
  meId,
}: {
  today: Promise<TodayData>;
  checklist: Promise<ChecklistView | null>;
  needsMailbox: Promise<boolean>;
  meId: string;
}) {
  const [d, checklist, needsMailbox] = await Promise.all([today, checklistP, needsMailboxP]);
  const count = d.items.length;
  const showChecklist = Boolean(checklist && !checklist.dismissed && !checklist.complete);
  // One "connect Gmail" prompt, not two (QA MIN-03): the checklist step covers it while the checklist is visible.
  const googleStepOpen = showChecklist && checklist!.steps.some((s) => s.id === "google" && !s.done);
  return (
    <>
      {needsMailbox && !googleStepOpen ? <MailboxBanner /> : null}
      <div className="grid gap-5 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <Card>
            <CardHeader className="items-center">
              <CardTitle className="flex items-baseline gap-2">
                {QUEUE_NAME}
                {count ? (
                  <span className="font-sans text-xs font-medium text-muted tabular" aria-label={`${count} item${count === 1 ? "" : "s"}`}>
                    {count}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TodayQueue items={d.items} nowIso={d.now} tz={d.tz} users={d.users} meId={meId} tomorrow={d.tomorrow} />
            </CardContent>
          </Card>
        </div>
        <div className="min-w-0 space-y-5 xl:col-span-2">
          {showChecklist && checklist ? <ChecklistCard steps={checklist.steps} done={checklist.done} total={checklist.total} /> : null}
          <GlanceStats overdue={d.stats.overdue} dueToday={d.stats.dueToday} alerts={d.stats.alerts} needNextStep={d.stats.needNextStep} />
          <HomeSection title="Today's meetings" href="/calls" hrefLabel="Calls" count={d.meetings.length}>
            <MeetingsList meetings={d.meetings} tz={d.tz} nowIso={d.now} />
          </HomeSection>
        </div>
      </div>
    </>
  );
}

function MainSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-5" aria-busy="true" aria-label={`Loading ${QUEUE_NAME}`}>
      <div className="space-y-2 rounded-lg border border-border p-5 xl:col-span-3">
        <Skeleton className="mb-4 h-6 w-24" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
      <div className="space-y-5 xl:col-span-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}
