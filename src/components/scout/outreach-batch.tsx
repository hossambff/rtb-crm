"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { fmtNumber } from "@/lib/format";
import { approveOutreachBatch, dismissOutreach, generateOpenersAction } from "@/lib/scout/outreach-actions";
import { cn } from "@/lib/utils";
import { VerificationBadge } from "./bits";

export type OutreachItem = {
  id: string;
  fullName: string;
  title: string | null;
  email: string;
  verification: string;
  accountId: string;
  accountName: string;
  fitScore: number | null;
  estMuu: number | null;
  opener: string | null;
  engine: string | null;
};
export type OutreachSequence = { id: string; name: string; usesOpener: boolean; stepCount: number };

/**
 * "Review batch" (V2 §A3): ≤ 20 enriched executives with a personal opener each. Edit inline, untick anyone you don't
 * want, then one explicit approval promotes them to Contacts and enrolls them (SCOUT-25: nothing is sent from here).
 */
export function OutreachBatch({ rows, more, sequences, gmailReady, connectHref }: { rows: OutreachItem[]; more: boolean; sequences: OutreachSequence[]; gmailReady: boolean; connectHref: string }) {
  const router = useRouter();
  // only the rep's edits live in state; everything else comes from the stored drafts (rows)
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const openerOf = (r: OutreachItem) => edits[r.id] ?? r.opener ?? "";
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(rows.filter((r) => r.verification === "valid").map((r) => r.id)));
  const [seqId, setSeqId] = React.useState(() => sequences.find((q) => q.usesOpener)?.id ?? sequences[0]?.id ?? "");
  const [generating, setGenerating] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<{ promoted: number; enrolled: number; skipped: { id: string; name: string; reason: string }[]; sequenceName: string; sequenceId: string } | null>(null);

  const generate = React.useCallback(
    async (ids: string[], force: boolean) => {
      if (!ids.length) return;
      setGenerating((g) => new Set([...g, ...ids]));
      const r = await generateOpenersAction({ ids, force });
      setGenerating((g) => new Set([...g].filter((x) => !ids.includes(x))));
      if (!r.ok) return void toast.error(r.error);
      if (force) setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !ids.includes(k))));
      router.refresh();
    },
    [router],
  );

  // first visit: draft openers for anyone who doesn't have one yet
  React.useEffect(() => {
    const missing = rows.filter((r) => !r.opener).map((r) => r.id);
    if (!missing.length) return;
    const t = setTimeout(() => void generate(missing, false), 0);
    return () => clearTimeout(t);
  }, [rows, generate]);

  const seq = sequences.find((q) => q.id === seqId) ?? null;
  const chosen = rows.filter((r) => selected.has(r.id));
  const empty = chosen.filter((r) => !openerOf(r).trim());

  async function approve() {
    if (!seq) return;
    setBusy(true);
    const r = await approveOutreachBatch({ sequenceId: seq.id, items: chosen.map((c) => ({ id: c.id, opener: openerOf(c) })) });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setDone(r.data);
    toast.success(`${r.data.enrolled} enrolled in “${r.data.sequenceName}”`);
    router.refresh();
  }

  if (done)
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-5 py-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-full border border-good/60 text-good">
            <Check className="size-5" aria-hidden />
          </span>
          <div>
            <p className="font-display text-xl text-fg">
              {done.enrolled} enrolled · {done.promoted} new contact{done.promoted === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-muted">First emails go out from your Gmail at the next slot in your working hours. Replies stop the sequence.</p>
          </div>
        </div>
        {done.skipped.length ? (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border text-sm">
            {done.skipped.map((s, i) => (
              <li key={`${s.id}-${i}`} className="flex justify-between gap-3 px-3 py-2">
                <span className="text-body">{s.name}</span>
                <span className="text-xs text-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`/sequences/${done.sequenceId}`}>Open sequence</Link>
          </Button>
          <Button size="sm" variant="primary" onClick={() => setDone(null)}>
            Next batch
          </Button>
        </div>
      </div>
    );

  if (!rows.length)
    return (
      <EmptyState
        title="No one to reach out to yet"
        description="Accept targets in the review queue and run “Find executives”. Verified executives you haven't contacted show up here with a personal opener."
        action={
          <Button asChild size="sm">
            <Link href="/scout?tab=runs">See enrichment runs</Link>
          </Button>
        }
      />
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="batch-seq">Enroll approved people in</Label>
          {sequences.length ? (
            <NativeSelect id="batch-seq" value={seqId} onChange={(e) => setSeqId(e.target.value)}>
              {sequences.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name} · {q.stepCount} steps{q.usesOpener ? " · uses opener" : ""}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <p className="text-sm text-secondary">
              No active sequence.{" "}
              <Link href="/sequences" className="text-fg underline underline-offset-2">
                Create one
              </Link>{" "}
              with <code className="text-xs">{"{{opener}}"}</code> in the first email.
            </p>
          )}
        </div>
        <Button size="sm" variant="ghost" disabled={generating.size > 0} onClick={() => generate(rows.map((r) => r.id), true)}>
          <RefreshCw aria-hidden className={cn(generating.size > 0 && "animate-spin motion-reduce:animate-none")} /> Redraft all
        </Button>
      </div>
      {seq && !seq.usesOpener ? <p className="text-xs text-warning">“{seq.name}” doesn’t use {"{{opener}}"} — the personal line won’t appear in the email.</p> : null}
      {!gmailReady ? (
        <p className="text-sm text-secondary">
          <Link href={connectHref} className="text-fg underline underline-offset-2">
            Connect your Gmail
          </Link>{" "}
          to approve — sequences send from your own inbox.
        </p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((r) => {
          const on = selected.has(r.id);
          const text = openerOf(r);
          const isGen = generating.has(r.id);
          return (
            <li key={r.id} className={cn("rounded-lg border bg-surface-1 transition-colors duration-150", on ? "border-border-strong" : "border-border opacity-70")}>
              <div className="flex flex-wrap items-start gap-3 px-4 pt-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-white"
                  aria-label={`Include ${r.fullName}`}
                  checked={on}
                  onChange={(e) => {
                    const n = new Set(selected);
                    if (e.target.checked) n.add(r.id);
                    else n.delete(r.id);
                    setSelected(n);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">
                    {r.fullName}
                    {r.title ? <span className="font-normal text-secondary"> · {r.title}</span> : null}
                  </p>
                  <p className="truncate text-xs text-muted">
                    <Link href={`/accounts/${r.accountId}`} className="hover:text-fg">
                      {r.accountName}
                    </Link>
                    {r.estMuu ? ` · ~${fmtNumber(r.estMuu, { compact: true })} MUU (est.)` : ""}
                    {r.fitScore != null ? ` · fit ${r.fitScore}` : ""} · {r.email}
                  </p>
                </div>
                <VerificationBadge v={r.verification} />
                {r.engine ? <Badge title={r.engine}>{r.engine.startsWith("ai:") ? <><Sparkles className="size-3" aria-hidden /> AI draft</> : r.engine === "manual" ? "Edited" : "Template"}</Badge> : null}
                <div className="flex gap-0.5">
                  <Button size="icon-sm" variant="ghost" aria-label={`Redraft opener for ${r.fullName}`} disabled={isGen} onClick={() => generate([r.id], true)}>
                    <RefreshCw className={cn(isGen && "animate-spin motion-reduce:animate-none")} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${r.fullName} from outreach`}
                    onClick={async () => {
                      const res = await dismissOutreach({ ids: [r.id] });
                      if (!res.ok) return void toast.error(res.error);
                      toast.message(`${r.fullName} won’t be offered again`);
                      router.refresh();
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </div>
              <div className="px-4 pb-3 pl-11 pt-2">
                <Textarea
                  aria-label={`Opener for ${r.fullName}`}
                  rows={2}
                  maxLength={400}
                  placeholder={isGen ? "Drafting a personal opener…" : "Write one specific line for this person"}
                  value={text}
                  disabled={isGen}
                  onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
                  className="min-h-14 text-sm"
                />
                <p className="mt-1 text-right text-[11px] tabular text-muted">{text.length}/400</p>
              </div>
            </li>
          );
        })}
      </ul>
      {more ? <p className="text-xs text-muted">More people are waiting — approve or remove these to see the next batch.</p> : null}

      <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-3">
        <p className="min-w-0 flex-1 text-xs text-muted">
          {chosen.length} selected{empty.length ? ` · ${empty.length} without an opener` : ""}. Approving adds them to Contacts and enrolls them — nothing is sent until the sequence’s first step, from your Gmail.
        </p>
        <Button variant="primary" disabled={busy || !seq || !chosen.length || empty.length > 0 || !gmailReady || generating.size > 0} onClick={approve}>
          <Send aria-hidden /> {busy ? "Enrolling…" : `Approve ${chosen.length} & enroll`}
        </Button>
      </div>
    </div>
  );
}
