"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { discardEnriched, promoteEnriched } from "@/lib/scout/actions";
import { VerificationBadge } from "./bits";

export type StagedRow = {
  id: string;
  fullName: string;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailSource: string | null;
  verification: string;
  confidence: number | null;
  sourceActor: string | null;
  state: string;
  promotedContactId: string | null;
};

const SOURCE: Record<string, string> = { website: "Website", linkedin_profile: "LinkedIn profile", linkedin_finder: "LinkedIn email finder", pattern_smtp: "Pattern + SMTP" };

/** Staged enrichment results → promote selected to Contacts (origin lead_scout) or discard (SCOUT-16 step 6). */
export function StagedContacts({ rows, canReview, running }: { rows: StagedRow[]; canReview: boolean; running: boolean }) {
  const router = useRouter();
  const staged = rows.filter((r) => r.state === "staged");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(staged.filter((r) => r.verification === "valid").map((r) => r.id)));
  const [busy, setBusy] = React.useState(false);
  if (!rows.length) return <EmptyState title={running ? "Looking for executives…" : "No executives found"} description={running ? "Results appear here when the run finishes." : "Try broader target roles, or add the company's LinkedIn URL to the account."} />;
  const sel = [...selected];
  return (
    <div className="space-y-3">
      {canReview ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs tabular text-muted">{sel.length} selected</span>
          <Button
            size="sm"
            variant="primary"
            disabled={!sel.length || busy}
            onClick={async () => {
              setBusy(true);
              const r = await promoteEnriched({ ids: sel });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              toast.success(`Promoted ${r.data.promoted} to Contacts${r.data.skipped ? ` (${r.data.skipped} skipped)` : ""}`);
              setSelected(new Set());
              router.refresh();
            }}
          >
            Promote to Contacts
          </Button>
          <Button
            size="sm"
            disabled={!sel.length || busy}
            onClick={async () => {
              setBusy(true);
              const r = await discardEnriched({ ids: sel });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              toast.success(`Discarded ${r.data.discarded}`);
              setSelected(new Set());
              router.refresh();
            }}
          >
            Discard
          </Button>
          <span className="text-xs text-muted">Nothing is emailed — outreach stays rep-initiated.</span>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="table-cards w-full min-w-[820px] text-sm">
          <thead className="bg-surface-1 text-left text-xs font-medium text-muted">
            <tr className="border-b border-border">
              <th className="w-9 px-3 py-2">
                <span className="sr-only">Select</span>
              </th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Title</th>
              <th className="px-2 py-2">Email</th>
              <th className="px-2 py-2">Verification</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2 text-right">Confidence</th>
              <th className="px-2 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td data-label="Select" className="px-3 py-2">
                  <input
                    type="checkbox"
                    className="accent-white"
                    aria-label={`Select ${r.fullName}`}
                    disabled={!canReview || r.state !== "staged"}
                    checked={selected.has(r.id)}
                    onChange={() =>
                      setSelected((p) => {
                        const n = new Set(p);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                </td>
                <td data-primary className="px-2 py-2">
                  <span className="text-fg">{r.fullName}</span>
                  {r.linkedinUrl ? (
                    <a className="ml-2 text-xs text-muted underline underline-offset-2 hover:text-fg" href={r.linkedinUrl} target="_blank" rel="noopener noreferrer">
                      LinkedIn
                    </a>
                  ) : null}
                </td>
                <td data-label="Title" className="px-2 py-2 text-secondary">{r.title ?? "—"}</td>
                <td data-label="Email" className="break-all px-2 py-2 font-mono text-xs text-body">{r.email ?? <span className="font-sans text-muted">not found</span>}</td>
                <td data-label="Verification" className="px-2 py-2">{r.email ? <VerificationBadge v={r.verification} /> : null}</td>
                <td data-label="Source" className="px-2 py-2 text-xs text-muted">
                  <span className="min-w-0">
                    {r.emailSource ? (SOURCE[r.emailSource] ?? r.emailSource) : "—"}
                    {r.sourceActor ? <span className="block break-all font-mono text-[10px]">{r.sourceActor}</span> : null}
                  </span>
                </td>
                <td data-label="Confidence" className="px-2 py-2 text-right tabular text-secondary">{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "—"}</td>
                <td data-label="State" className="px-2 py-2">
                  {r.state === "promoted" ? (
                    r.promotedContactId ? (
                      <Link href={`/contacts/${r.promotedContactId}`} className="text-xs underline underline-offset-2">
                        In Contacts
                      </Link>
                    ) : (
                      <Badge>Promoted</Badge>
                    )
                  ) : r.state === "discarded" ? (
                    <Badge className="border-dashed text-muted">Discarded</Badge>
                  ) : (
                    <Badge>Staged</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
