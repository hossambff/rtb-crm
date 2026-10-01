"use client";
import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, Link2, ShieldAlert } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createShareLinkAction, listShareLinksAction, revokeShareLinkAction } from "@/lib/share/actions";
import { SHARE_EXPIRY_DAYS, SHARE_FIELD_LABELS, SHARE_FIELDS, type ShareField } from "@/lib/share/fields";
import type { ShareLinkView } from "@/lib/share/service";
import { cn } from "@/lib/utils";

const DEFAULT_FIELDS: ShareField[] = ["stage", "nextStep", "closeDate"];

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).format(new Date(iso));

function StateBadge({ state }: { state: ShareLinkView["state"] }) {
  if (state === "active") return <StatusBadge status="good" label="Active" />;
  if (state === "expired") return <StatusBadge status="info" label="Expired" />;
  return <StatusBadge status="critical" label="Revoked" />;
}

/**
 * "Share with partner": create a read-only link (URL shown once), list / revoke existing links with view counts.
 * Used from the deal header (one deal) and from lists (a filtered set of deals).
 */
export function ShareDialog({
  open,
  onOpenChange,
  dealIds,
  defaultLabel,
  allowedFields,
  scopeDealId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dealIds: string[];
  defaultLabel: string;
  allowedFields: ShareField[];
  /** List only links that include this deal (deal page). */
  scopeDealId?: string;
}) {
  const [tab, setTab] = React.useState("new");
  const [label, setLabel] = React.useState(defaultLabel);
  const [partner, setPartner] = React.useState("");
  const [fields, setFields] = React.useState<ShareField[]>(DEFAULT_FIELDS.filter((f) => allowedFields.includes(f)));
  const [days, setDays] = React.useState<(typeof SHARE_EXPIRY_DAYS)[number]>(30);
  const [busy, startTransition] = React.useTransition();
  const [created, setCreated] = React.useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [links, setLinks] = React.useState<ShareLinkView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadLinks = React.useCallback(async () => {
    const res = await listShareLinksAction({ dealId: scopeDealId });
    if (res.ok) setLinks(res.data);
    else setLinks([]);
  }, [scopeDealId]);

  const reset = () => {
    setCreated(null);
    setCopied(false);
    setError(null);
    setTab("new");
  };

  const create = () =>
    startTransition(async () => {
      setError(null);
      const res = await createShareLinkAction({ dealIds, label, partnerName: partner || null, fields, expiryDays: days });
      if (!res.ok) return void setError(res.fieldErrors ? (Object.values(res.fieldErrors)[0]?.[0] ?? res.error) : res.error);
      setCreated({ url: res.data.url, expiresAt: res.data.expiresAt });
      if (res.data.skipped) toast.info(`${res.data.skipped} deal${res.data.skipped === 1 ? " was" : "s were"} left out — restricted (MNPI) or not yours to edit.`);
      void loadLinks();
    });

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually.");
    }
  };

  const revoke = (id: string) =>
    startTransition(async () => {
      const res = await revokeShareLinkAction({ id });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Link turned off");
      await loadLinks();
    });

  const activeCount = links?.filter((l) => l.state === "active").length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogContent onOpenAutoFocus={() => void loadLinks()}>
        <DialogHeader>
          <DialogTitle>Share with partner</DialogTitle>
          <DialogDescription>
            A read-only status page anyone with the link can open — no sign-in. {dealIds.length > 1 ? `${dealIds.length} deals.` : null}
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="px-5">
            <TabsTrigger value="new">New link</TabsTrigger>
            <TabsTrigger value="links">
              Links{links ? <span className="ml-1 tabular-nums text-muted">{activeCount}</span> : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="new">
            {created ? (
              <DialogBody>
                <div className="rounded-lg border border-border-strong bg-surface-1 p-4">
                  <p className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Check className="size-4 text-good" aria-hidden /> Link ready
                  </p>
                  <p className="mt-1 text-xs text-muted">Copy it now — for security it is shown only once. Valid until {fmt(created.expiresAt)}.</p>
                  <div className="mt-3 flex gap-2">
                    <Input readOnly value={created.url} aria-label="Partner link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                    <Button variant="primary" onClick={copy} aria-label="Copy link">
                      {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              </DialogBody>
            ) : (
              <DialogBody>
                <div className="space-y-1.5">
                  <Label htmlFor="share-label">Link name</Label>
                  <Input id="share-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="Arena — NET status" />
                  <p className="text-xs text-muted">Shown as the page title.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="share-partner">Partner (optional)</Label>
                  <Input id="share-partner" value={partner} maxLength={120} onChange={(e) => setPartner(e.target.value)} placeholder="e.g. Arena Group" />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-secondary">What the partner sees</legend>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {SHARE_FIELDS.map((f) => {
                      const allowed = allowedFields.includes(f);
                      const on = fields.includes(f);
                      return (
                        <label
                          key={f}
                          className={cn(
                            "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors duration-150",
                            on ? "border-border-strong bg-surface-3/50 text-fg" : "border-border text-secondary hover:bg-surface-3/30",
                            !allowed && "cursor-not-allowed opacity-40",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-white"
                            checked={on}
                            disabled={!allowed}
                            onChange={(e) => setFields((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))}
                          />
                          {SHARE_FIELD_LABELS[f]}
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted">Values, revenue share, notes and contacts are never shared. Restricted deals can’t be shared.</p>
                </fieldset>
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium text-secondary">Expires after</legend>
                  <div role="radiogroup" className="inline-flex rounded-md border border-border p-0.5">
                    {SHARE_EXPIRY_DAYS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={days === d}
                        onClick={() => setDays(d)}
                        className={cn(
                          "h-8 rounded px-3 text-sm tabular-nums transition-colors duration-150",
                          days === d ? "bg-white text-black" : "text-secondary hover:text-fg",
                        )}
                      >
                        {d} days
                      </button>
                    ))}
                  </div>
                </fieldset>
                {error ? (
                  <p role="alert" className="flex items-start gap-2 text-xs text-secondary">
                    <ShieldAlert className="mt-px size-3.5 shrink-0 text-critical" aria-hidden /> {error}
                  </p>
                ) : null}
              </DialogBody>
            )}
            <DialogFooter>
              {created ? (
                <>
                  <Button variant="ghost" onClick={() => setCreated(null)}>
                    Create another
                  </Button>
                  <Button variant="primary" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                </>
              ) : (
                <Button variant="primary" disabled={busy || !fields.length || !label.trim()} onClick={create}>
                  <Link2 /> {busy ? "Creating…" : "Create link"}
                </Button>
              )}
            </DialogFooter>
          </TabsContent>

          <TabsContent value="links">
            <DialogBody>
              {links === null ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : !links.length ? (
                <p className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted">No partner links yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
                  {links.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm text-fg">{l.label}</span>
                          <StateBadge state={l.state} />
                          {l.dealCount > 1 ? <Badge>{l.dealCount} deals</Badge> : null}
                        </div>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                          {l.partnerName ? <span>{l.partnerName}</span> : null}
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Eye className="size-3" aria-hidden /> {l.viewCount} view{l.viewCount === 1 ? "" : "s"}
                            {l.lastViewedAt ? ` · last ${fmt(l.lastViewedAt)}` : ""}
                          </span>
                          <span>{l.state === "active" ? `expires ${fmt(l.expiresAt)}` : `created ${fmt(l.createdAt)}`}</span>
                          {!l.mine && l.creatorName ? <span>by {l.creatorName}</span> : null}
                        </p>
                      </div>
                      {l.canRevoke ? (
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => revoke(l.id)}>
                          Turn off
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted">Links can’t be shown again after creation. Turn one off and create a new link if you need it.</p>
            </DialogBody>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Button + dialog for a set of deals (lists / filtered views). Server-side checks decide what can be shared. */
export function ShareDealsButton({
  dealIds,
  defaultLabel = "Partner status",
  allowedFields = [...SHARE_FIELDS],
  scopeDealId,
  size = "sm",
}: {
  dealIds: string[];
  defaultLabel?: string;
  allowedFields?: ShareField[];
  scopeDealId?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size={size} variant="secondary" disabled={!dealIds.length} onClick={() => setOpen(true)}>
        <Link2 /> Share
      </Button>
      <ShareDialog open={open} onOpenChange={setOpen} dealIds={dealIds} defaultLabel={defaultLabel} allowedFields={allowedFields} scopeDealId={scopeDealId} />
    </>
  );
}
