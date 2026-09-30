import Link from "next/link";
import { Link2, Lock } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ThreadListItem } from "@/lib/gmail/queries";
import { INTENT_LABELS, inboxHref, type InboxParams } from "./inbox-filters";

function people(participants: string[], ownEmail: string): string {
  const others = participants.filter((p) => p !== ownEmail.toLowerCase());
  if (!others.length) return "—";
  const first = others.slice(0, 2).map((e) => e.split("@")[0]);
  return others.length > 2 ? `${first.join(", ")} +${others.length - 2}` : first.join(", ");
}

export function ThreadList({ threads, params, selectedId, userId, userEmail }: { threads: ThreadListItem[]; params: InboxParams; selectedId?: string; userId: string; userEmail: string }) {
  return (
    <ul className="divide-y divide-border" aria-label="Email threads">
      {threads.map((t) => {
        const selected = t.id === selectedId;
        return (
          <li key={t.id}>
            <Link
              href={inboxHref(params, { thread: t.id })}
              aria-current={selected ? "true" : undefined}
              className={cn("block px-4 py-3 transition-colors", selected ? "bg-surface-2" : "hover:bg-surface-2/50")}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className={cn("truncate text-sm", t.awaitingReplyFrom === "us" ? "font-medium text-fg" : "text-body")}>{people(t.participants, userEmail)}</p>
                <time className="shrink-0 text-[11px] text-muted tabular" dateTime={t.lastMessageAt?.toISOString()}>
                  {fmtRelative(t.lastMessageAt)}
                </time>
              </div>
              <p className="mt-0.5 truncate text-sm text-secondary">
                {t.private ? <Lock className="mr-1 inline size-3 text-muted" aria-label="Private" /> : null}
                {t.subject ?? "(no subject)"}
                {t.messageCount > 1 ? <span className="ml-1 text-xs text-muted tabular">({t.messageCount})</span> : null}
              </p>
              {t.snippet ? <p className="mt-0.5 line-clamp-1 text-xs text-muted">{t.snippet}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {t.awaitingReplyFrom === "us" ? <StatusBadge status="warning" label="Reply owed" /> : null}
                {t.awaitingReplyFrom === "them" ? <Badge>Waiting on them</Badge> : null}
                {t.aiIntent && t.aiIntent !== "other" ? <Badge>{INTENT_LABELS[t.aiIntent] ?? t.aiIntent}</Badge> : null}
                {t.dealId ? (
                  <Badge className="max-w-48">
                    <Link2 className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{t.dealName ?? "Linked deal"}</span>
                  </Badge>
                ) : t.accountName ? (
                  <Badge className="max-w-48 text-muted">
                    <span className="truncate">{t.accountName}</span>
                  </Badge>
                ) : null}
                {t.mailboxUserId !== userId ? <span className="text-[11px] text-muted">· {t.mailboxName}&apos;s mailbox</span> : null}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
