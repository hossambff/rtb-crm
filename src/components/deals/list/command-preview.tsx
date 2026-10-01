"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Lock, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { executeCommand, undoCommandAction } from "@/lib/commands/actions";
import type { Preview } from "@/lib/commands/types";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ModKey } from "@/components/ui/mod-key";

const VERB_LABEL: Record<string, string> = { move: "Move", assign: "Assign", tag: "Tag", close: "Update", enroll: "Enroll" };

/**
 * Preview → confirm for every bulk change (⌘K sentences and the /deals bulk bar). Shows exactly which records change
 * (permission-filtered server-side), which are skipped and why, lets the user untick rows, then runs the signed command.
 * After success: a toast with Undo (the undo token is valid for 15 minutes; records changed since are kept). Large
 * commands run in chunks: the dialog keeps calling execute with the remaining ids until done (CR M4).
 */
export function CommandPreviewDialog({
  open,
  onOpenChange,
  preview,
  loading,
  error,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  preview: Preview | null;
  loading?: boolean;
  error?: string | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [unticked, setUnticked] = React.useState<Set<string>>(new Set());
  const [reasonCode, setReasonCode] = React.useState("");
  const [reasonText, setReasonText] = React.useState("");
  const [seenToken, setSeenToken] = React.useState(preview?.token);
  if (seenToken !== preview?.token) {
    setSeenToken(preview?.token);
    setUnticked(new Set());
    setReasonCode("");
    setReasonText("");
  }

  const actionable = preview?.rows.filter((r) => !r.skip) ?? [];
  const chosen = actionable.filter((r) => !unticked.has(r.id));
  const skipped = preview?.rows.filter((r) => r.skip) ?? [];
  const nr = preview?.needsReason ?? null;
  // QA MIN-34: with an empty reason picklist a free-text reason is enough.
  const reasonOk = !nr || (nr.category === "won" || !nr.options.length ? reasonText.trim().length >= 3 : Boolean(reasonCode));
  const canRun = Boolean(preview?.token) && chosen.length > 0 && reasonOk && !pending;
  const verb = preview ? (VERB_LABEL[preview.command.verb] ?? "Run") : "Run";

  const run = () =>
    startTransition(async () => {
      if (!preview) return;
      // Chunked execution: keep going with the same signed token while the server reports remaining ids.
      let ids = chosen.map((c) => c.id);
      const undoTokens: string[] = [];
      const sk: { id: string; name: string; reason: string }[] = [];
      let changed = 0;
      let message = "";
      for (let round = 0; ids.length && round < 25; round++) {
        const r = await executeCommand({ token: preview.token, ids, reasonCode: reasonCode || undefined, reasonText: reasonText.trim() || undefined });
        if (!r.ok) {
          toast.error(changed ? `${r.error} (${changed} already changed)` : r.error);
          break;
        }
        changed += r.data.changed;
        sk.push(...r.data.skipped);
        if (r.data.undoToken) undoTokens.push(r.data.undoToken);
        message = r.data.message.replace(/ · \d+ still to go$/, "");
        const next = r.data.remaining ?? [];
        if (next.length) toast.loading(`Working… ${next.length} to go`, { id: "command-progress" });
        if (next.length >= ids.length) break; // no progress — stop rather than loop
        ids = next;
      }
      toast.dismiss("command-progress");
      if (!message) return;
      const desc = sk.length ? `${sk.length} skipped: ${sk.slice(0, 3).map((s) => `${s.name} — ${s.reason}`).join("; ")}${sk.length > 3 ? "…" : ""}` : undefined;
      const undo = undoTokens.length
        ? {
            label: "Undo",
            onClick: () => {
              void (async () => {
                let undone = 0;
                const kept: string[] = [];
                let lastMessage = "";
                for (const token of undoTokens) {
                  const u = await undoCommandAction({ token });
                  if (!u.ok) {
                    toast.error(u.error);
                    continue;
                  }
                  undone += u.data.changed;
                  lastMessage = u.data.message;
                  kept.push(...u.data.skipped.map((x) => `${x.name} — ${x.reason}`));
                }
                if (lastMessage) {
                  const text = undoTokens.length > 1 ? `Undid ${undone} change${undone === 1 ? "" : "s"}` : lastMessage;
                  (kept.length ? toast.warning : toast.success)(text, {
                    icon: <Undo2 className="size-4" />,
                    description: kept.length ? `${kept.length} kept (changed since): ${kept.slice(0, 3).join("; ")}${kept.length > 3 ? "…" : ""}` : undefined,
                  });
                }
                router.refresh();
              })();
            },
          }
        : undefined;
      (sk.length ? toast.warning : toast.success)(message, { description: desc, action: undo, duration: undo ? 30_000 : 6_000 });
      onOpenChange(false);
      onDone?.();
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={(o) => (!pending ? onOpenChange(o) : undefined)}>
      <DialogContent className="max-w-2xl p-0" onKeyDown={(e) => (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canRun ? run() : undefined)}>
        <DialogHeader>
          <DialogTitle>{loading ? "Preparing preview…" : preview ? preview.summary : "Preview"}</DialogTitle>
          <DialogDescription>
            {preview ? (
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{preview.filterText}</span>
                <span className="inline-flex items-center gap-1 rounded border border-border-strong px-1 text-[10px] uppercase tracking-wider">
                  {preview.engine.startsWith("ai:") ? <Sparkles className="size-3" aria-hidden /> : null}
                  {preview.engine.startsWith("ai:") ? "AI-parsed" : "rules"}
                </span>
                {preview.undoable ? <span className="text-[11px]">· undo from the confirmation toast</span> : <span className="text-[11px]">· can&apos;t be undone</span>}
              </span>
            ) : (
              "Nothing changes until you confirm."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] overflow-y-auto">
          {error ? (
            <p className="flex items-start gap-2 rounded-md border border-border-strong px-3 py-2 text-sm text-body">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> {error}
            </p>
          ) : null}
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : null}
          {preview && !loading ? (
            <>
              {preview.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 rounded-md border border-border-strong px-3 py-2 text-xs text-body">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden /> {w}
                </p>
              ))}
              {preview.disabledReason ? <p className="rounded-md border border-border-strong px-3 py-2 text-xs text-body">{preview.disabledReason}</p> : null}
              {nr ? (
                <div className="flex flex-wrap items-center gap-2">
                  {nr.options.length ? (
                    <NativeSelect aria-label={`${nr.category} reason`} className="h-8 w-auto text-xs" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                      <option value="">{nr.category === "lost" ? "Lost reason…" : "Hold reason…"}</option>
                      {nr.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : null}
                  <Input aria-label="Reason details" className="h-8 min-w-48 flex-1 text-xs" placeholder={nr.category === "won" ? "Why were these won? (required)" : nr.options.length ? "Details (optional)" : "Reason (required)"} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
                </div>
              ) : null}
              {preview.rows.length ? (
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center justify-between border-b border-border bg-surface-1 px-3 py-1.5 text-[11px] text-muted">
                    <span className="tabular">
                      {chosen.length} of {actionable.length} will change{skipped.length ? ` · ${skipped.length} skipped` : ""}
                    </span>
                    {actionable.length > 1 ? (
                      <button type="button" className="hover:text-fg" onClick={() => setUnticked(unticked.size ? new Set() : new Set(actionable.map((a) => a.id)))}>
                        {unticked.size ? "Select all" : "Clear all"}
                      </button>
                    ) : null}
                  </div>
                  <ul className="max-h-80 divide-y divide-border overflow-y-auto" role="list">
                    {preview.rows.map((r) => (
                      <li key={r.id} className={cn("flex items-center gap-2 px-3 py-1.5 text-[13px]", r.skip ? "opacity-60" : "")}>
                        <input
                          type="checkbox"
                          className="size-3.5 shrink-0 accent-white"
                          aria-label={`Include ${r.name}`}
                          disabled={Boolean(r.skip) || pending}
                          checked={!r.skip && !unticked.has(r.id)}
                          onChange={(e) =>
                            setUnticked((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.delete(r.id);
                              else n.add(r.id);
                              return n;
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1">
                            <Link href={`/deals/${r.id}`} className="truncate text-fg hover:underline" target="_blank">
                              {r.name}
                            </Link>
                            {r.restricted ? <Lock className="size-3 shrink-0 text-secondary" aria-label="Restricted" /> : null}
                          </span>
                          <span className="block truncate text-[11px] text-muted">
                            {[r.pipelineKey, r.stageName, r.ownerName ?? "Unassigned", r.idleDays != null ? `idle ${r.idleDays}d` : null].filter(Boolean).join(" · ")}
                            {r.skip ? <span className="text-secondary"> — {r.skip}</span> : r.note ? <span> — {r.note}</span> : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted tabular">{fmtUsd(r.weightedUsd, { compact: true })}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : !preview.warnings.length && !preview.disabledReason ? (
                <p className="rounded-md border border-dashed border-border-strong px-3 py-6 text-center text-sm text-muted">No deals match.</p>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="items-center">
          <span className="mr-auto hidden text-[11px] text-muted sm:inline">
            <kbd className="rounded border border-border-strong px-1">
              <ModKey />
            </kbd> <kbd className="rounded border border-border-strong px-1">Enter</kbd> to confirm
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={run} disabled={!canRun}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {verb} {chosen.length} deal{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
