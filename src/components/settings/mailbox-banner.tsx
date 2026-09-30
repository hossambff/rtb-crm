import Link from "next/link";
import { MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * EML-12 banner: connecting Gmail is mandatory for sales roles. Server-renderable; show it when
 * `needsMailboxConnection(user)` (src/lib/integrations/queries.ts) is true — e.g. on My Day and Inbox.
 */
export function MailboxBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-3">
      <MailWarning className="size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">Connect your inbox to finish onboarding</p>
        {!compact ? (
          <p className="text-xs text-muted">
            Your role requires Gmail + Calendar so deal emails, commitments and meetings are captured automatically. Only threads with known
            contacts or accounts are logged.
          </p>
        ) : null}
      </div>
      <Button asChild size="sm" variant="primary">
        <Link href="/settings#connections">Connect inbox</Link>
      </Button>
    </div>
  );
}
