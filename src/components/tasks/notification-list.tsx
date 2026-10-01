"use client";
import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRightLeft, AtSign, Bell, CheckCheck, ClipboardCheck, HandHelping, ListChecks, Lock, Newspaper, Siren, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/notifications/actions";
import type { NotificationView } from "@/lib/notifications/queries";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Bell> = { alert: Siren, mention: AtSign, approval: ClipboardCheck, digest: Newspaper, task: ListChecks, handoff: ArrowRightLeft, help: HandHelping, assignment: UserCheck };

export function NotificationList({ items }: { items: NotificationView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const unread = items.filter((n) => !n.read).length;

  const mark = (n: NotificationView, read: boolean) =>
    start(async () => {
      const res = await markNotificationRead({ id: n.id, read });
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-secondary">
          <span className="tabular">{unread}</span> unread
        </p>
        <Button
          size="sm"
          disabled={!unread || pending}
          onClick={() =>
            start(async () => {
              const res = await markAllNotificationsRead({});
              if (!res.ok) return void toast.error(res.error);
              toast.success(`Marked ${res.data.count} as read`);
              router.refresh();
            })
          }
        >
          <CheckCheck /> Mark all read
        </Button>
      </div>
      {!items.length ? (
        <EmptyState title="No notifications" description="Alerts, approvals, assignments and your daily digest show up here." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
          {items.map((n) => {
            const Icon = ICONS[n.kind] ?? Bell;
            return (
              <li key={n.id} className={cn("flex items-start gap-3 px-4 py-3", !n.read && "bg-surface-2/40")}>
                <Icon className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-muted" : "text-fg")} strokeWidth={1.5} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm", n.read ? "text-secondary" : "font-medium text-fg")}>
                    {!n.read ? <span className="sr-only">Unread: </span> : null}
                    {n.href ? (
                      <Link href={n.href} className="hover:underline" onClick={() => !n.read && mark(n, true)}>
                        {n.title}
                      </Link>
                    ) : (
                      n.title
                    )}
                  </p>
                  {n.body ? <p className="mt-0.5 whitespace-pre-line text-xs text-secondary">{n.body}</p> : null}
                  <p className="mt-1 text-[11px] text-muted" suppressHydrationWarning>
                    {fmtRelative(n.createdAt)}
                    {n.digestOnly ? <span> · Quiet — {n.inDigest ? "included in your daily digest" : "will be in your next daily digest"} (over your alert budget)</span> : null}
                    {n.sensitive ? (
                      <span className="inline-flex items-center gap-0.5">
                        {" · "}
                        <Lock className="size-3" aria-hidden /> Restricted — stays in Roundtable
                      </span>
                    ) : null}
                  </p>
                </div>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => mark(n, !n.read)} aria-label={n.read ? `Mark unread: ${n.title}` : `Mark read: ${n.title}`}>
                  {n.read ? "Mark unread" : "Mark read"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
