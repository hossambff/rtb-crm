import { requireUser } from "@/lib/rbac/server";
import { PageHeader } from "@/components/ui/misc";
import { AlertList } from "@/components/alerts/alert-list";
import { TaskList } from "@/components/tasks/task-list";
import { NewTaskButton } from "@/components/tasks/new-task-button";
import { ApprovalsList } from "@/components/tasks/approvals-list";
import { AttentionDeals, HeroStats, HomeSection, InboxAwaiting, MeetingsList } from "@/components/home/sections";
import { loadMyDay } from "@/lib/tasks/home";
import { fmtInTz } from "@/lib/tasks/core";
import { toWall } from "@/lib/alerts/time";

export const metadata = { title: "My Day" };

function greeting(now: Date, tz: string) {
  const h = toWall(now, tz).getUTCHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function HomePage() {
  const user = await requireUser();
  const d = await loadMyDay(user);
  const tz = user.timezone;
  const first = user.name.split(" ")[0];
  const focus = [...d.buckets.overdue, ...d.buckets.today];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting(d.now, tz)}, ${first}`}
        description={`${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(d.now)}, ${fmtInTz(d.now, tz, "date")} — your tasks, alerts and meetings for today.`}
        actions={d.canTasks ? <NewTaskButton users={d.users} /> : null}
      />

      <HeroStats overdue={d.buckets.overdue.length} dueToday={d.buckets.today.length} alerts={d.alertCounts} needNextStep={d.needNextStep} />

      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          {d.canTasks ? (
            <HomeSection title="Overdue & today" href="/tasks?tab=mine" count={focus.length}>
              <TaskList
                groups={[
                  { key: "overdue", label: "Overdue", tasks: d.buckets.overdue },
                  { key: "today", label: "Today", tasks: d.buckets.today },
                ]}
                users={d.users}
                tz={tz}
                emptyTitle="Nothing due today"
                emptyDescription={d.buckets.upcoming.length ? `${d.buckets.upcoming.length} upcoming task(s) — see Tasks.` : "Promises from email and calls become tasks automatically."}
              />
            </HomeSection>
          ) : null}
          <HomeSection title="Alerts" href="/tasks?tab=alerts" count={d.alertCounts.critical + d.alertCounts.serious + d.alertCounts.warning + d.alertCounts.info}>
            <AlertList alerts={d.alerts} tz={tz} compact />
          </HomeSection>
          <HomeSection title="Deals needing attention" href="/pipelines" hrefLabel="Pipelines">
            <AttentionDeals deals={d.attentionDeals} tz={tz} />
          </HomeSection>
        </div>
        <div className="space-y-6 xl:col-span-2">
          <HomeSection title="Today's meetings" href="/calls" hrefLabel="Calls" count={d.meetings.length}>
            <MeetingsList meetings={d.meetings} tz={tz} nowIso={d.now.toISOString()} />
          </HomeSection>
          {d.canEmail ? (
            <HomeSection title="Awaiting your reply" href="/inbox" hrefLabel="Inbox" count={d.threads.length}>
              <InboxAwaiting threads={d.threads} tz={tz} />
            </HomeSection>
          ) : null}
          {d.showApprovals ? (
            <HomeSection title="Pending approvals" href="/tasks?tab=approvals" count={d.approvals.length}>
              <ApprovalsList pending={d.approvals} mine={[]} tz={tz} />
            </HomeSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
