import Link from "next/link";
import { MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";

/**
 * EML-12 banner: connecting Gmail is mandatory for sales roles. Server-renderable; show it when
 * `needsMailboxConnection(user)` (src/lib/integrations/queries.ts) is true — e.g. on My Day and Inbox.
 * When Google OAuth isn't configured on the server the copy says so (QA-05) and the link still lands on the
 * Settings → Connections card, which explains what an admin must set.
 */
export function MailboxBanner({ compact = false, configured = env.googleConfigured }: { compact?: boolean; configured?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-3">
      <MailWarning className="size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{configured ? "Connect your inbox to finish onboarding" : "Inbox connection unavailable — Google sign-in not configured"}</p>
        {!compact ? (
          <p className="text-xs text-muted">
            {configured
              ? "Your role requires Gmail + Calendar so deal emails, commitments and meetings are captured automatically. Only threads with known contacts or accounts are logged."
              : "Ask an admin to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Until then, log emails and meetings on the deal."}
          </p>
        ) : null}
      </div>
      <Button asChild size="sm" variant={configured ? "primary" : "secondary"}>
        <Link href="/settings#connections">{configured ? "Connect inbox" : "View details"}</Link>
      </Button>
    </div>
  );
}
