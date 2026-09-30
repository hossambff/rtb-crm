"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlarmClock, Check, MoreHorizontal, Sparkles, UserRoundPen, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { dismissAlert, reassignAlert, resolveAlert, snoozeAlert } from "@/lib/alerts/actions";
import type { AlertView } from "@/lib/alerts/queries";
import type { UserOption } from "@/lib/tasks/queries";
import { fmtInTz } from "@/lib/tasks/core";
import { fmtRelative } from "@/lib/format";
import { ReasonDialog } from "@/components/tasks/reason-dialog";
import { SeverityBadge } from "./severity-badge";

type Dlg = { kind: "snooze" | "dismiss" | "reassign"; alert: AlertView } | null;

/** Reusable alert list (home + tasks). Actions: done, snooze (reason + until), reassign, draft with Copilot, dismiss (reason). */
export function AlertList({
  alerts,
  users = [],
  canReassign = false,
  tz,
  compact = false,
  emptyTitle = "Nothing slipping",
  emptyDescription = "No open alerts. The sweep checks deals, tasks, emails and meetings around the clock.",
}: {
  alerts: AlertView[];
  users?: UserOption[];
  canReassign?: boolean;
  tz: string;
  compact?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const router = useRouter();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [pending, start] = useTransition();
  const [target, setTarget] = useState("");

  if (!alerts.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  const done = (a: AlertView) =>
    start(async () => {
      const res = await resolveAlert({ id: a.id });
      if (res.ok) {
        toast.success("Alert resolved");
        router.refresh();
      } else toast.error(res.error);
    });

  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1" aria-label="Alerts">
        {alerts.map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-4 py-3">
            <div className="shrink-0 pt-0.5">
              <SeverityBadge severity={a.severity} />
            </div>
            <div className="min-w-0 flex-1">
              <Link href={a.href} className="block truncate text-sm font-medium text-fg hover:underline">
                {a.title}
              </Link>
              {!compact && a.detail ? <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-secondary">{a.detail}</p> : null}
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                <span title={a.ruleName ?? undefined}>{a.ruleCode}</span>
                <span aria-hidden>·</span>
                <span suppressHydrationWarning>{fmtRelative(a.createdAt)}</span>
                {a.suggestedAction && !compact ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-secondary">{a.suggestedAction}</span>
                  </>
                ) : null}
                {a.state === "escalated" ? <Badge>Escalated</Badge> : null}
                {a.state === "snoozed" && a.snoozedUntil ? <Badge>Snoozed until {fmtInTz(a.snoozedUntil, tz)}</Badge> : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={`Mark done: ${a.title}`} title="Done" disabled={pending} onClick={() => done(a)}>
                <Check />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Snooze: ${a.title}`} title="Snooze" onClick={() => setDlg({ kind: "snooze", alert: a })}>
                <AlarmClock />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More actions: ${a.title}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={`/copilot?alertId=${a.id}`}>
                      <Sparkles /> Draft it for me
                    </Link>
                  </DropdownMenuItem>
                  {canReassign ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setTarget("");
                        setDlg({ kind: "reassign", alert: a });
                      }}
                    >
                      <UserRoundPen /> Reassign
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDlg({ kind: "dismiss", alert: a })}>
                    <XCircle className="text-critical" /> Dismiss…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
      </ul>

      <ReasonDialog
        open={dlg?.kind === "snooze"}
        onOpenChange={(o) => !o && setDlg(null)}
        title="Snooze alert"
        description={dlg?.alert.title}
        withUntil
        tz={tz}
        confirmLabel="Snooze"
        onSubmit={async ({ reason, until }) => {
          const res = await snoozeAlert({ id: dlg!.alert.id, reason, until: until! });
          if (!res.ok) return res.fieldErrors?.reason?.[0] ?? res.error;
          toast.success("Alert snoozed");
          router.refresh();
          return null;
        }}
      />
      <ReasonDialog
        open={dlg?.kind === "dismiss"}
        onOpenChange={(o) => !o && setDlg(null)}
        title="Dismiss alert"
        description="Dismissals are audit-logged with your reason."
        confirmLabel="Dismiss"
        onSubmit={async ({ reason }) => {
          const res = await dismissAlert({ id: dlg!.alert.id, reason });
          if (!res.ok) return res.fieldErrors?.reason?.[0] ?? res.error;
          toast.success("Alert dismissed");
          router.refresh();
          return null;
        }}
      />
      <Dialog open={dlg?.kind === "reassign"} onOpenChange={(o) => !o && setDlg(null)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!target || !dlg) return;
              start(async () => {
                const res = await reassignAlert({ id: dlg.alert.id, userId: target });
                if (!res.ok) return void toast.error(res.error);
                toast.success("Alert reassigned");
                setDlg(null);
                router.refresh();
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Reassign alert</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm text-secondary">{dlg?.alert.title}</p>
              <div className="space-y-1.5">
                <Label htmlFor="reassign-user">Assign to</Label>
                <NativeSelect id="reassign-user" value={target} onChange={(e) => setTarget(e.target.value)} required>
                  <option value="">Choose a person…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDlg(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!target || pending}>
                Reassign
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
