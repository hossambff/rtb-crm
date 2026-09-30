"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserSearch } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { getEnrichmentPreview, startEnrichment } from "@/lib/scout/actions";
import { CostEstimate, type BudgetView, type EstimateLine } from "./budget-notice";
import { TagInput } from "./tag-input";

type Preview = {
  accountName: string;
  domain: string | null;
  apifyConnected: boolean;
  defaultRoles: string[];
  motion: string;
  estimate: { cents: number; lines: EstimateLine[] };
  budget: BudgetView;
  pendingRequest: boolean;
};

/**
 * "Find executives" (PRD SCOUT-16). Embeddable on account pages, deal cards and review-queue rows:
 *   <EnrichButton accountId={a.id} motion="NET" dealId={d.id} />
 * Default target roles come from the motion's admin preset (settings scout.target_roles) and are editable.
 * Shows the cost estimate and budget before running; results land in staging for review — nothing is sent.
 */
export function EnrichButton({
  accountId,
  motion,
  dealId,
  candidateId,
  label = "Find executives",
  size = "sm",
  variant = "secondary",
}: {
  accountId: string;
  motion?: string;
  dealId?: string;
  candidateId?: string;
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [roles, setRoles] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [runId, setRunId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setPreview(null);
    setError(null);
    setRunId(null);
    const r = await getEnrichmentPreview({ accountId, motion });
    if (!r.ok) return setError(r.error);
    setPreview(r.data as Preview);
    setRoles(r.data.defaultRoles);
  }, [accountId, motion]);

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <UserSearch aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Find executives{preview ? ` — ${preview.accountName}` : ""}</DialogTitle>
            <DialogDescription>Website, public LinkedIn and email finders via Apify. Results are staged for your review; nothing is sent.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error ? (
              <p className="text-sm text-secondary">{error}</p>
            ) : !preview ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : !preview.apifyConnected ? (
              <p className="text-sm text-secondary">Executive enrichment needs the org Apify token. Ask an admin to connect Apify in Lead Scout → Settings.</p>
            ) : runId ? (
              <div className="space-y-2 text-sm text-secondary">
                <p>Enrichment started. Progress is saved step by step — you can close this dialog.</p>
                <Link className="text-fg underline underline-offset-4" href={`/scout/runs/${runId}`}>
                  Open run & review contacts
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="enrich-roles">Target roles ({preview.motion} preset)</Label>
                  <TagInput id="enrich-roles" value={roles} onChange={setRoles} placeholder="Add a title, press Enter" aria-label="Target roles" />
                  <p className="text-xs text-muted">Matched against titles; senior titles are used if no one matches.</p>
                </div>
                <CostEstimate lines={preview.estimate.lines} budget={preview.budget} entity="account" entityId={accountId} pendingRequest={preview.pendingRequest} />
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {runId ? "Close" : "Cancel"}
            </Button>
            {preview?.apifyConnected && !runId ? (
              <Button
                type="button"
                variant="primary"
                disabled={busy || !roles.length || !preview.budget.allowed}
                onClick={async () => {
                  setBusy(true);
                  const r = await startEnrichment({ accountId, dealId, candidateId, targetRoles: roles });
                  setBusy(false);
                  if (!r.ok) return void toast.error(r.error);
                  if (r.data.blocked) return void toast.error(r.data.message);
                  setRunId(r.data.runId);
                  toast.success("Enrichment started");
                  router.refresh();
                }}
              >
                {busy ? "Starting…" : "Run enrichment"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
