import Link from "next/link";
import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Calm "Connect Apify" state: explains what works without a token instead of an error wall. */
export function ConnectApify({ canConfigure, compact = false }: { canConfigure: boolean; compact?: boolean }) {
  return (
    <section aria-label="Apify not connected" className="mb-6 rounded-lg border border-border bg-surface-1 px-5 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <PlugZap className="mt-0.5 size-5 text-secondary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg text-fg">Connect Apify to discover and enrich</p>
          {!compact ? (
            <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Works now</p>
                <ul className="mt-1 space-y-1 text-secondary">
                  <li>Upload or paste a domain list and score it against the CRM</li>
                  <li>Enter MUU manually per domain (otherwise marked unknown)</li>
                  <li>Review, accept into a pipeline, reject, snooze</li>
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Needs Apify</p>
                <ul className="mt-1 space-y-1 text-secondary">
                  <li>Lookalike and keyword discovery</li>
                  <li>Similarweb traffic → MUU estimates, tech stack</li>
                  <li>Finding executives, emails and verification</li>
                </ul>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted">Domain-list scoring works without it; discovery, traffic and executive enrichment need an Apify token.</p>
          )}
        </div>
        {canConfigure ? (
          <Button asChild variant="secondary" size="sm">
            <Link href="/scout?tab=settings">Add Apify token</Link>
          </Button>
        ) : (
          <p className="text-xs text-muted">Ask an admin to add the org Apify token.</p>
        )}
      </div>
    </section>
  );
}
