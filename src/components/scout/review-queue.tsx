"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, Clock, Copy, LayoutGrid, Rows3, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ColorTick } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { acceptCandidates, markDuplicate, rejectCandidates, restoreCandidates, snoozeCandidates } from "@/lib/scout/actions";
import { cn } from "@/lib/utils";
import { ConfidenceBadge, FactorBars, FitScore, Sparkline, Trend } from "./bits";
import { EnrichButton } from "./enrich-button";

export type CandidateRow = {
  id: string;
  domain: string;
  name: string | null;
  category: string | null;
  country: string | null;
  estMuu: number | null;
  muuSource: string | null;
  muuConfidence: string;
  monthlyVisits: number | null;
  trendPct: number | null;
  series: number[];
  techStack: string[];
  displaceable: string[];
  ownership: string | null;
  fitScore: number | null;
  fitFactors: Record<string, number>;
  fitExplanation: string | null;
  estValueCents: number | null;
  crmLabel: string;
  crmStatus: string;
  accountId: string | null;
  dealId: string | null;
  routing: string;
  routingReason: string | null;
  state: string;
  rejectReason: string | null;
  searchName: string;
  source: string;
  doNotContact: boolean;
  canEdit: boolean;
};

type Props = {
  rows: CandidateRow[];
  pipelines: { key: string; name: string; color: string }[];
  users: { id: string; name: string; role: string }[] | null; // null → can't assign to others
  currentUserId: string;
  suggestOnly: boolean;
  rejectReasons: string[];
  apifyConnected: boolean;
  searches: { id: string; name: string }[];
  weights: Record<string, number>;
  canEnrich: boolean;
};

const OWNERSHIP: Record<string, string> = { independent: "Independent", founder_led: "Founder-led", group_owned: "Group-owned", public_company: "Public" };

export function ReviewQueue(props: Props) {
  const { rows } = props;
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const view = React.useSyncExternalStore(viewStore.subscribe, viewStore.get, () => "table" as const);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [acceptFor, setAcceptFor] = React.useState<string[] | null>(null);
  const [rejectFor, setRejectFor] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  // reset selection when the server sends a new list (after an action / filter change)
  const [prevRows, setPrevRows] = React.useState(rows);
  if (rows !== prevRows) {
    setPrevRows(rows);
    setSelected(new Set());
  }

  const editable = rows.filter((r) => r.canEdit && r.state !== "accepted");
  const allSelected = editable.length > 0 && editable.every((r) => selected.has(r.id));
  const sel = [...selected];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function run<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>, success: (d: T) => string) {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(success(r.data));
    router.refresh();
  }

  const bulk = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted tabular">{sel.length} selected</span>
      <Button size="sm" variant="primary" disabled={!sel.length || busy} onClick={() => setAcceptFor(sel)}>
        <Check aria-hidden /> {props.suggestOnly ? "Suggest to SVP" : "Accept"}
      </Button>
      {!props.suggestOnly ? (
        <>
          <Button size="sm" disabled={!sel.length || busy} onClick={() => setRejectFor(sel)}>
            <X aria-hidden /> Reject
          </Button>
          <SnoozeMenu disabled={!sel.length || busy} onPick={(days) => run(snoozeCandidates({ ids: sel, days }), (d) => `Snoozed ${d.count}`)} />
          <Button size="sm" variant="ghost" disabled={!sel.length || busy} onClick={() => run(markDuplicate({ ids: sel }), (d) => `Marked ${d.count} as duplicate`)}>
            <Copy aria-hidden /> Duplicate
          </Button>
        </>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3">
      <QueueFilters searches={props.searches} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {bulk}
        <div className="flex items-center gap-1" role="group" aria-label="View">
          <Button size="icon-sm" variant={view === "table" ? "secondary" : "ghost"} aria-label="Table view" aria-pressed={view === "table"} onClick={() => viewStore.set("table")}>
            <Rows3 />
          </Button>
          <Button size="icon-sm" variant={view === "cards" ? "secondary" : "ghost"} aria-label="Card view" aria-pressed={view === "cards"} onClick={() => viewStore.set("cards")}>
            <LayoutGrid />
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing to review"
          description="Run a search, or upload a domain list to score it against the CRM."
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/scout/searches/new">New search</Link>
            </Button>
          }
        />
      ) : (
        <>
          {/* table on md+ (unless cards chosen); cards always on small screens */}
          <div className={cn("hidden overflow-x-auto rounded-lg border border-border", view === "table" && "md:block")}>
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-surface-1 text-left text-xs font-medium text-muted">
                <tr className="border-b border-border">
                  <th className="w-9 px-3 py-2">
                    <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(editable.map((r) => r.id)))} className="accent-white" />
                  </th>
                  <th className="px-2 py-2">Site</th>
                  <th className="px-2 py-2">Category</th>
                  <th className="px-2 py-2 text-right">Est. MUU</th>
                  <th className="px-2 py-2">Trend</th>
                  <th className="px-2 py-2">Fit</th>
                  <th className="px-2 py-2">Tech</th>
                  <th className="px-2 py-2">Ownership</th>
                  <th className="px-2 py-2">CRM status</th>
                  <th className="px-2 py-2 text-right">Est. value</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr className={cn("border-b border-border align-top hover:bg-surface-2/60", selected.has(r.id) && "bg-surface-2")}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" aria-label={`Select ${r.domain}`} disabled={!r.canEdit || r.state === "accepted"} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="accent-white" />
                      </td>
                      <td className="px-2 py-2.5">
                        <button type="button" className="flex items-start gap-1.5 text-left" onClick={() => setExpanded(expanded === r.id ? null : r.id)} aria-expanded={expanded === r.id}>
                          {expanded === r.id ? <ChevronDown className="mt-0.5 size-3.5 text-muted" aria-hidden /> : <ChevronRight className="mt-0.5 size-3.5 text-muted" aria-hidden />}
                          <span>
                            <span className="block font-medium text-fg">{r.name ?? r.domain}</span>
                            <span className="block text-xs text-muted">
                              {r.domain}
                              {r.country ? ` · ${r.country}` : ""}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="px-2 py-2.5 text-secondary">{r.category ?? "—"}</td>
                      <td className="px-2 py-2.5 text-right">
                        <span className="block tabular text-body">{r.estMuu != null ? fmtNumber(r.estMuu, { compact: true }) : "—"}</span>
                        <ConfidenceBadge confidence={r.muuConfidence} />
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <Sparkline series={r.series} />
                          <Trend pct={r.trendPct} />
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <FitScore score={r.fitScore} />
                      </td>
                      <td className="px-2 py-2.5">
                        <TechChips tech={r.techStack} highlight={r.displaceable} />
                      </td>
                      <td className="px-2 py-2.5 text-secondary">{r.ownership ? (OWNERSHIP[r.ownership] ?? r.ownership) : "—"}</td>
                      <td className="max-w-52 px-2 py-2.5 text-xs text-secondary">
                        <CrmCell r={r} />
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <span className="tabular text-body">{r.estValueCents != null ? fmtUsd(r.estValueCents / 100, { compact: true }) : "—"}</span>
                        <span className="block text-[10px] uppercase tracking-wide text-muted">estimate</span>
                      </td>
                      <td className="px-2 py-2.5">
                        <RowActions r={r} {...props} onAccept={() => setAcceptFor([r.id])} onReject={() => setRejectFor([r.id])} busy={busy} run={run} />
                      </td>
                    </tr>
                    {expanded === r.id ? (
                      <tr className="border-b border-border bg-surface-1">
                        <td />
                        <td colSpan={10} className="px-2 py-3">
                          <Details r={r} weights={props.weights} />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", view === "table" && "md:hidden")}>
            {rows.map((r) => (
              <article key={r.id} className={cn("rounded-lg border border-border bg-surface-1 p-4", selected.has(r.id) && "border-border-strong bg-surface-2")}>
                <div className="flex items-start gap-3">
                  <input type="checkbox" aria-label={`Select ${r.domain}`} disabled={!r.canEdit || r.state === "accepted"} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="mt-1 accent-white" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg">{r.name ?? r.domain}</p>
                    <p className="text-xs text-muted">
                      {r.domain} · {r.category ?? "—"}
                      {r.country ? ` · ${r.country}` : ""}
                    </p>
                  </div>
                  <FitScore score={r.fitScore} size="lg" />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className="tabular text-body">{r.estMuu != null ? `${fmtNumber(r.estMuu, { compact: true })} MUU` : "MUU unknown"}</span>
                  <ConfidenceBadge confidence={r.muuConfidence} />
                  <Trend pct={r.trendPct} />
                  <span className="tabular text-secondary">{r.estValueCents != null ? `${fmtUsd(r.estValueCents / 100, { compact: true })} est.` : ""}</span>
                </div>
                <p className="mt-2 text-xs text-secondary">
                  <CrmCell r={r} />
                </p>
                <div className="mt-3">
                  <FactorBars factors={r.fitFactors} weights={props.weights} />
                </div>
                {r.fitExplanation ? <p className="mt-2 text-xs text-muted">{r.fitExplanation}</p> : null}
                <div className="mt-3 flex justify-end">
                  <RowActions r={r} {...props} onAccept={() => setAcceptFor([r.id])} onReject={() => setRejectFor([r.id])} busy={busy} run={run} />
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <AcceptDialog key={acceptFor?.join(",") ?? "closed"} ids={acceptFor} onClose={() => setAcceptFor(null)} {...props} />
      <RejectDialog ids={rejectFor} onClose={() => setRejectFor(null)} reasons={props.rejectReasons} />
    </div>
  );
}

/** Per-viewer table/card preference (localStorage; falls back to table). */
const viewListeners = new Set<() => void>();
const viewStore = {
  get(): "table" | "cards" {
    try {
      return localStorage.getItem("scout.view") === "cards" ? "cards" : "table";
    } catch {
      return "table";
    }
  },
  set(v: "table" | "cards") {
    try {
      localStorage.setItem("scout.view", v);
    } catch {
      /* storage unavailable */
    }
    viewListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    viewListeners.add(l);
    return () => {
      viewListeners.delete(l);
    };
  },
};

function CrmCell({ r }: { r: CandidateRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {r.crmStatus === "new" ? <Badge>New</Badge> : <span>{r.crmLabel}</span>}
      {r.doNotContact ? <Badge className="border-dashed">Do not contact</Badge> : null}
      {r.accountId && r.crmStatus !== "new" ? (
        <Link className="text-muted underline underline-offset-2 hover:text-fg" href={`/accounts/${r.accountId}`}>
          account
        </Link>
      ) : null}
    </span>
  );
}

function TechChips({ tech, highlight }: { tech: string[]; highlight: string[] }) {
  if (!tech.length) return <span className="text-xs text-muted">—</span>;
  const shown = [...highlight, ...tech.filter((t) => !highlight.some((h) => t.toLowerCase().includes(h.toLowerCase())))].slice(0, 3);
  return (
    <div className="flex max-w-48 flex-wrap gap-1">
      {shown.map((t) => (
        <Badge key={t} className={cn("max-w-36 truncate whitespace-nowrap", highlight.includes(t) && "border-secondary text-body")}>
          {t}
        </Badge>
      ))}
      {tech.length > 3 ? <span className="text-[11px] text-muted">+{tech.length - 3}</span> : null}
    </div>
  );
}

function Details({ r, weights }: { r: CandidateRow; weights: Record<string, number> }) {
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <div className="space-y-2 text-sm">
        <p className="text-body">{r.fitExplanation ?? "No explanation."}</p>
        <p className="text-xs text-muted">
          Routing suggestion: <ColorTick color={PIPELINE_COLORS[r.routing] ?? "#828282"} className="mx-1 align-middle" />
          <span className="text-secondary">{r.routing}</span> — {r.routingReason ?? ""}
        </p>
        <p className="text-xs text-muted">
          MUU source: {r.muuSource ?? "none"}
          {r.monthlyVisits != null ? ` · ${fmtNumber(r.monthlyVisits)} monthly visits` : ""} · found via {r.source} · search “{r.searchName}”
        </p>
        {r.techStack.length ? <p className="text-xs text-muted">Stack: {r.techStack.slice(0, 20).join(", ")}</p> : null}
        {r.rejectReason ? <p className="text-xs text-muted">Rejected: {r.rejectReason}</p> : null}
      </div>
      <FactorBars factors={r.fitFactors} weights={weights} />
    </div>
  );
}

function RowActions({
  r,
  onAccept,
  onReject,
  busy,
  run,
  suggestOnly,
  canEnrich,
  apifyConnected,
}: Props & {
  r: CandidateRow;
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
  run: <T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>, success: (d: T) => string) => Promise<void>;
}) {
  if (r.state === "accepted")
    return (
      <div className="flex justify-end gap-1">
        {r.accountId && canEnrich && apifyConnected && !r.doNotContact ? <EnrichButton accountId={r.accountId} motion={r.routing} dealId={r.dealId ?? undefined} candidateId={r.id} label="Enrich" /> : <Badge>Accepted</Badge>}
      </div>
    );
  if (!r.canEdit) return <span className="block text-right text-xs text-muted">View only</span>;
  if (r.state === "rejected" || r.state === "duplicate" || r.state === "snoozed")
    return (
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(restoreCandidates({ ids: [r.id] }), () => "Moved back to the queue")}>
          <Undo2 aria-hidden /> Restore
        </Button>
      </div>
    );
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="primary" disabled={busy} onClick={onAccept}>
        {suggestOnly ? "Suggest" : "Accept"}
      </Button>
      {!suggestOnly ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${r.domain}`}>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onReject}>
              <X /> Reject…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run(snoozeCandidates({ ids: [r.id], days: 30 }), () => "Snoozed for 30 days")}>
              <Clock /> Snooze 30 days
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run(markDuplicate({ ids: [r.id] }), () => "Marked as duplicate")}>
              <Copy /> Mark duplicate
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function SnoozeMenu({ disabled, onPick }: { disabled: boolean; onPick: (days: number) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Clock aria-hidden /> Snooze
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {[7, 30, 90].map((d) => (
          <DropdownMenuItem key={d} onSelect={() => onPick(d)}>
            {d} days
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AcceptDialog({ ids, onClose, rows, pipelines, users, currentUserId, suggestOnly, apifyConnected, canEnrich }: Props & { ids: string[] | null; onClose: () => void }) {
  const router = useRouter();
  const chosen = React.useMemo(() => rows.filter((r) => ids?.includes(r.id)), [rows, ids]);
  const suggested = chosen.length === 1 ? chosen[0]!.routing : "";
  const [pipelineKey, setPipelineKey] = React.useState<string>(suggested);
  const [ownerId, setOwnerId] = React.useState(currentUserId);
  const [enrich, setEnrich] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [outcomes, setOutcomes] = React.useState<{ domain: string; ok: boolean; message: string; runId?: string | null }[] | null>(null);

  return (
    <Dialog open={Boolean(ids)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{suggestOnly ? "Suggest targets" : `Accept ${chosen.length} target${chosen.length === 1 ? "" : "s"}`}</DialogTitle>
          <DialogDescription>
            {suggestOnly
              ? "Your SVP approves suggested targets before they enter a pipeline."
              : "Creates or updates the account and a Target-stage deal with next step “First outreach” due in 2 business days."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {outcomes ? (
            <ul className="space-y-1.5 text-sm">
              {outcomes.map((o) => (
                <li key={o.domain} className="flex items-start gap-2">
                  {o.ok ? <Check className="mt-0.5 size-4 text-secondary" aria-hidden /> : <X className="mt-0.5 size-4 text-muted" aria-hidden />}
                  <span>
                    <span className="text-fg">{o.domain}</span> <span className="text-secondary">— {o.message}</span>
                    {o.runId ? (
                      <Link className="ml-1 text-xs underline underline-offset-2" href={`/scout/runs/${o.runId}`}>
                        view run
                      </Link>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="accept-pipeline">Pipeline</Label>
                <NativeSelect id="accept-pipeline" value={pipelineKey} onChange={(e) => setPipelineKey(e.target.value)}>
                  {chosen.length > 1 ? <option value="">Suggested per target (NET / SPT / ENT routing)</option> : null}
                  {pipelines.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} — {p.name}
                      {p.key === suggested ? " (suggested)" : ""}
                    </option>
                  ))}
                </NativeSelect>
                {chosen.length === 1 && chosen[0]!.routingReason ? <p className="text-xs text-muted">{chosen[0]!.routingReason}</p> : null}
              </div>
              {!suggestOnly ? (
                <div className="space-y-1.5">
                  <Label htmlFor="accept-owner">Owner</Label>
                  <NativeSelect id="accept-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={!users}>
                    {users ? (
                      users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                          {u.id === currentUserId ? " (me)" : ""}
                        </option>
                      ))
                    ) : (
                      <option value={currentUserId}>Me</option>
                    )}
                  </NativeSelect>
                  {!users ? <p className="text-xs text-muted">Your role accepts targets to yourself.</p> : null}
                </div>
              ) : null}
              {!suggestOnly && canEnrich ? (
                <label className={cn("flex items-center gap-2 text-sm", !apifyConnected && "opacity-50")}>
                  <input type="checkbox" className="accent-white" checked={enrich} disabled={!apifyConnected} onChange={(e) => setEnrich(e.target.checked)} />
                  Start executive enrichment now {apifyConnected ? "(budget checked per account)" : "(needs Apify)"}
                </label>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {outcomes ? "Close" : "Cancel"}
          </Button>
          {!outcomes ? (
            <Button
              variant="primary"
              disabled={busy || !ids?.length}
              onClick={async () => {
                if (!ids) return;
                setBusy(true);
                const r = await acceptCandidates({ ids, pipelineKey: (pipelineKey || undefined) as "NET" | "SPT" | "ENT" | undefined, ownerId, enrich });
                setBusy(false);
                if (!r.ok) return void toast.error(r.error);
                if (r.data.suggested) {
                  toast.success(`Suggested ${r.data.suggested} target${r.data.suggested > 1 ? "s" : ""} to your SVP`);
                  onClose();
                } else {
                  setOutcomes(r.data.outcomes);
                  const ok = r.data.outcomes.filter((o) => o.ok).length;
                  if (ok) toast.success(`Accepted ${ok}`);
                }
                router.refresh();
              }}
            >
              {busy ? "Working…" : suggestOnly ? "Send suggestion" : "Accept"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ ids, onClose, reasons }: { ids: string[] | null; onClose: () => void; reasons: string[] }) {
  const router = useRouter();
  const [reason, setReason] = React.useState(reasons[0] ?? "Other");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={Boolean(ids)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject {ids?.length === 1 ? "target" : `${ids?.length ?? 0} targets`}</DialogTitle>
          <DialogDescription>Rejected domains won’t be scouted again for 6 months. Reasons feed Fit Score calibration.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <NativeSelect id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reject-note">Note (optional)</Label>
            <Textarea id="reject-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!ids) return;
              setBusy(true);
              const r = await rejectCandidates({ ids, reason, note: note.trim() || undefined });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              toast.success(`Rejected ${r.data.count}`);
              setNote("");
              onClose();
              router.refresh();
            }}
          >
            <X aria-hidden /> Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueueFilters({ searches }: { searches: { id: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = React.useState(sp.get("q") ?? "");
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    n.set("tab", "queue");
    router.replace(`${pathname}?${n.toString()}`);
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        set("q", q.trim());
      }}
    >
      <div className="w-56">
        <Label htmlFor="q-filter" className="sr-only">
          Search domains
        </Label>
        <Input id="q-filter" placeholder="Filter by domain or name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="w-40">
        <Label htmlFor="state-filter" className="sr-only">
          State
        </Label>
        <NativeSelect id="state-filter" value={sp.get("state") ?? "queue"} onChange={(e) => set("state", e.target.value === "queue" ? "" : e.target.value)}>
          <option value="queue">To review</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="snoozed">Snoozed</option>
          <option value="duplicate">Duplicates</option>
          <option value="all">All</option>
        </NativeSelect>
      </div>
      <div className="w-56">
        <Label htmlFor="search-filter" className="sr-only">
          Search
        </Label>
        <NativeSelect id="search-filter" value={sp.get("search") ?? ""} onChange={(e) => set("search", e.target.value)}>
          <option value="">All searches</option>
          {searches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="w-36">
        <Label htmlFor="score-filter" className="sr-only">
          Minimum Fit Score
        </Label>
        <NativeSelect id="score-filter" value={sp.get("min") ?? ""} onChange={(e) => set("min", e.target.value)}>
          <option value="">Any score</option>
          <option value="70">Fit ≥ 70</option>
          <option value="50">Fit ≥ 50</option>
          <option value="30">Fit ≥ 30</option>
        </NativeSelect>
      </div>
    </form>
  );
}
