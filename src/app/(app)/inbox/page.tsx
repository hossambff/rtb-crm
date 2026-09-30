import Link from "next/link";
import { requireUser } from "@/lib/rbac/server";
import { emailScope, getThread, inboxCounts, listThreads, type InboxFilters as Filters } from "@/lib/gmail/queries";
import { getGoogleAccount } from "@/lib/integrations/google";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, hasScope } from "@/lib/integrations/core";
import { mailboxRequired } from "@/lib/integrations/queries";
import { getConnection } from "@/lib/integrations/store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InboxFilters, inboxHref, type InboxParams } from "@/components/inbox/inbox-filters";
import { SyncButton } from "@/components/inbox/sync-button";
import { ThreadList } from "@/components/inbox/thread-list";
import { ThreadView } from "@/components/inbox/thread-view";
import { MailboxBanner } from "@/components/settings/mailbox-banner";

export const metadata = { title: "Inbox" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const user = await requireUser();
  const sp = await searchParams;
  const params: InboxParams = {
    awaiting: one(sp.awaiting),
    intent: one(sp.intent),
    linked: one(sp.linked),
    mailbox: one(sp.mailbox),
    view: one(sp.view),
    q: one(sp.q)?.slice(0, 100),
    thread: one(sp.thread),
  };
  const scope = await emailScope(user);
  if (scope === "none") {
    return (
      <>
        <PageHeader title="Inbox" />
        <EmptyState title="No access" description="Your role doesn't include the Inbox. Ask an admin if you need it." />
      </>
    );
  }
  const filters: Filters = {
    awaiting: params.awaiting === "us" || params.awaiting === "them" ? params.awaiting : undefined,
    intent: params.intent,
    linked: params.linked === "linked" || params.linked === "unlinked" ? params.linked : undefined,
    mailbox: params.mailbox === "mine" || params.mailbox === "team" ? params.mailbox : undefined,
    view: params.view === "private" ? "private" : undefined,
    q: params.q,
  };
  const uuid = /^[0-9a-f-]{36}$/i;
  const [acct, gmailConn, threads, counts, detail] = await Promise.all([
    getGoogleAccount(user.id),
    getConnection(user.id, "gmail"),
    listThreads(user, filters),
    inboxCounts(user),
    params.thread && uuid.test(params.thread) ? getThread(user, params.thread) : Promise.resolve(null),
  ]);
  const connected = hasScope(acct?.scope, GMAIL_READ_SCOPE);
  const canSend = hasScope(acct?.scope, GMAIL_SEND_SCOPE);
  const backHref = inboxHref(params, { thread: undefined });
  const filtered = Boolean(filters.awaiting || filters.intent || filters.linked || filters.q || filters.mailbox);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inbox"
        description={
          connected
            ? `Deal-relevant email from your Gmail${gmailConn?.lastSyncAt ? ` · synced ${fmtRelative(gmailConn.lastSyncAt)}` : ""}${gmailConn?.status === "error" ? " · sync needs attention" : ""}`
            : "Deal-relevant email, commitments and reply status — once your Gmail is connected."
        }
        actions={connected ? <SyncButton disabled={gmailConn?.status === "revoked"} /> : null}
      />
      {!connected && mailboxRequired(user.role) ? (
        <div className="mb-4">
          <MailboxBanner />
        </div>
      ) : null}
      {gmailConn?.status === "error" && gmailConn.lastError ? (
        <p role="alert" className="mb-4 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-xs text-secondary">
          Last sync failed: {gmailConn.lastError}{" "}
          <Link href="/settings#connections" className="text-fg underline underline-offset-2">
            Open settings
          </Link>
        </p>
      ) : null}
      <InboxFilters params={params} counts={counts} canSeeTeam={scope === "team" || scope === "all"} />

      {threads.length === 0 && !detail ? (
        filtered || filters.view ? (
          <EmptyState
            title="No threads match"
            description="Try a different filter or clear the search."
            action={
              <Button asChild size="sm" variant="secondary">
                <Link href="/inbox">Clear filters</Link>
              </Button>
            }
          />
        ) : connected ? (
          <EmptyState
            title="Nothing logged yet"
            description="Only threads with known contacts or account domains show up here. The first sync backfills recent email; new mail arrives every few minutes."
            action={<SyncButton />}
          />
        ) : (
          <EmptyState
            title="Connect your inbox"
            description="Connect Gmail + Calendar in Settings. RTB logs only threads with known contacts or accounts, extracts commitments and tracks who owes the next reply."
            action={
              <Button asChild size="sm" variant="primary">
                <Link href="/settings#connections">Connect inbox</Link>
              </Button>
            }
          />
        )
      ) : (
        <div className="grid min-h-[60vh] gap-4 xl:grid-cols-[minmax(320px,400px)_1fr]">
          <Card className={cn("overflow-hidden", detail && "hidden xl:block")}>
            <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
              {threads.length ? (
                <ThreadList threads={threads} params={params} selectedId={detail?.thread.id} userId={user.id} userEmail={user.email} />
              ) : (
                <p className="px-4 py-6 text-sm text-muted">No threads match these filters.</p>
              )}
            </div>
          </Card>
          <Card className={cn("min-w-0 overflow-hidden", !detail && "hidden xl:block")}>
            {detail ? (
              <ThreadView detail={detail} backHref={backHref} userEmail={user.email} canSend={canSend} />
            ) : params.thread ? (
              <div className="p-6">
                <EmptyState title="Thread not available" description="It may be private, unlinked, or outside your access." />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted">
                Select a thread to see messages, AI-extracted commitments and reply options.
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
