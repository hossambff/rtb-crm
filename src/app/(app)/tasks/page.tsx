import { redirect } from "next/navigation";
import { requireUser, can, scopeFor } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { PageHeader } from "@/components/ui/misc";
import { TabNav, type TabDef } from "@/components/tasks/tab-nav";
import { TaskList, type TaskGroup } from "@/components/tasks/task-list";
import { NewTaskButton } from "@/components/tasks/new-task-button";
import { NotificationList } from "@/components/tasks/notification-list";
import { ApprovalsList } from "@/components/tasks/approvals-list";
import { AlertList } from "@/components/alerts/alert-list";
import { RunSweepButton } from "@/components/alerts/run-sweep-button";
import { assignableUsers, getTaskForUser, listMyTasks, listTeamTasks } from "@/lib/tasks/queries";
import { BUCKET_LABELS, BUCKET_ORDER, bucketTasks } from "@/lib/tasks/core";
import { alertCountsBySeverity, listMyAlerts } from "@/lib/alerts/queries";
import { listNotifications, unreadCount } from "@/lib/notifications/queries";
import { listApprovals, pendingApprovalCount } from "@/lib/approvals/service";

export const metadata = { title: "Tasks & Alerts" };

const TABS = ["mine", "team", "alerts", "notifications", "approvals"] as const;
type Tab = (typeof TABS)[number];

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const user = await requireUser();
  if (!(await can(user, "tasks", "view"))) redirect("/home");
  const sp = await searchParams;
  const taskParam = typeof sp.task === "string" ? sp.task : null;
  let tab: Tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "mine";

  const [viewScope, assignScope, alertCounts, unread, approvalsPending, isAdmin, users, deepTask] = await Promise.all([
    scopeFor(user, "tasks", "view"),
    scopeFor(user, "tasks", "assign"),
    alertCountsBySeverity(user),
    unreadCount(user),
    pendingApprovalCount(user),
    can(user, "admin", "configure", "all"),
    assignableUsers(user),
    taskParam && /^[0-9a-f-]{36}$/i.test(taskParam) ? getTaskForUser(user, taskParam) : Promise.resolve(null),
  ]);
  const hasTeam = SCOPE_RANK[viewScope] >= SCOPE_RANK.team;
  const approver = approvalsPending > 0 || ["executive", "admin", "super_admin", "sales_leader", "finance"].includes(user.role);
  if (deepTask && !sp.tab) tab = deepTask.assigneeId === user.id ? "mine" : "team";
  if (tab === "team" && !hasTeam) tab = "mine";

  const tabs: TabDef[] = [
    { key: "mine", label: "My tasks" },
    ...(hasTeam ? [{ key: "team", label: "Team" }] : []),
    { key: "alerts", label: "Alerts", count: alertCounts.critical + alertCounts.serious + alertCounts.warning + alertCounts.info },
    { key: "notifications", label: "Notifications", count: unread },
    { key: "approvals", label: "Approvals", count: approvalsPending },
  ];
  const tz = user.timezone;
  const now = new Date();
  const canReassign = SCOPE_RANK[assignScope] >= SCOPE_RANK.team;

  let body: React.ReactNode = null;
  if (tab === "mine") {
    const { open, done } = await listMyTasks(user);
    const b = bucketTasks(open, now, tz);
    const groups: TaskGroup[] = [
      ...BUCKET_ORDER.map((k) => ({ key: k, label: BUCKET_LABELS[k], tasks: b[k] })),
      { key: "done", label: "Done in the last 7 days", tasks: done },
    ];
    body = <TaskList groups={groups} users={users} tz={tz} initialOpenId={deepTask?.id} />;
  } else if (tab === "team") {
    const team = (await listTeamTasks(user)) ?? [];
    const b = bucketTasks(team, now, tz);
    body = (
      <TaskList
        groups={BUCKET_ORDER.map((k) => ({ key: k, label: BUCKET_LABELS[k], tasks: b[k] }))}
        users={users}
        tz={tz}
        showAssignee
        initialOpenId={deepTask?.id}
        emptyTitle="No open team tasks"
        emptyDescription={viewScope === "all" ? "Nobody else has open tasks." : "Your team has no open tasks."}
      />
    );
  } else if (tab === "alerts") {
    const alerts = await listMyAlerts(user, { includeSnoozed: true });
    body = <AlertList alerts={alerts} users={users} canReassign={canReassign} tz={tz} />;
  } else if (tab === "notifications") {
    body = <NotificationList items={await listNotifications(user)} />;
  } else {
    const { pending, mine } = await listApprovals(user);
    body = <ApprovalsList pending={pending} mine={mine} tz={tz} />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks & Alerts"
        description={approver ? "Your tasks, Nothing Slips alerts, notifications and approvals." : "Your tasks, Nothing Slips alerts and notifications."}
        actions={
          <>
            {tab === "alerts" && isAdmin ? <RunSweepButton /> : null}
            {(await can(user, "tasks", "create")) ? <NewTaskButton users={users} /> : null}
          </>
        }
      />
      <TabNav tabs={tabs} active={tab} basePath="/tasks" />
      <div>{body}</div>
      {tab === "mine" || tab === "team" ? (
        <p className="hidden text-[11px] text-muted md:block">
          Keyboard: <kbd>N</kbd> new task · <kbd>↑</kbd>/<kbd>↓</kbd> move · <kbd>X</kbd> complete · <kbd>E</kbd> edit · <kbd>S</kbd> snooze
        </p>
      ) : null}
    </div>
  );
}
