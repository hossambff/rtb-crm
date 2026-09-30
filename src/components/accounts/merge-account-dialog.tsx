"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { GitMerge, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mergeAccountInto, searchAccountsAction } from "@/lib/accounts/actions";

type Pick = { id: string; name: string; domain?: string | null };

/** Debounced account search combobox (keyboard: ↑/↓/Enter/Esc). */
export function AccountPicker({ id, value, onChange, excludeId, placeholder }: { id?: string; value: Pick | null; onChange: (v: Pick | null) => void; excludeId?: string; placeholder?: string }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Pick[]>([]);
  const [active, setActive] = React.useState(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = `${id ?? "acc"}-list`;

  React.useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      timer.current = setTimeout(() => setHits([]), 0);
      return;
    }
    timer.current = setTimeout(async () => {
      const res = await searchAccountsAction({ q: q.trim() });
      if (res.ok) {
        setHits(res.data.filter((a) => a.id !== excludeId));
        setActive(0);
      }
    }, 200);
  }, [q, excludeId]);

  if (value)
    return (
      <div className="flex h-9 items-center justify-between rounded-md border border-border bg-surface-3/40 px-3 text-sm">
        <span className="truncate text-fg">
          {value.name} {value.domain ? <span className="text-xs text-muted">{value.domain}</span> : null}
        </span>
        <button type="button" aria-label="Clear selection" className="text-muted hover:text-fg" onClick={() => onChange(null)}>
          <X className="size-4" />
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={q}
        placeholder={placeholder ?? "Search accounts…"}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            onChange(hits[active]!);
            setQ("");
            setHits([]);
          } else if (e.key === "Escape") setHits([]);
        }}
      />
      {hits.length ? (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border-strong bg-surface-2 p-1 text-sm">
          {hits.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(h);
                setQ("");
                setHits([]);
              }}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 ${i === active ? "bg-surface-3" : ""}`}
            >
              <span className="truncate text-fg">{h.name}</span>
              <span className="truncate text-xs text-muted">{h.domain ?? ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MergeAccountDialog({ account }: { account: { id: string; name: string } }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dup, setDup] = React.useState<Pick | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDup(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <GitMerge /> Merge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge a duplicate into {account.name}</DialogTitle>
          <DialogDescription>
            Deals, contacts, activities, tasks, documents and audience metrics move here. The duplicate is archived (soft-deleted), its domain kept as an alternate domain. Audit-logged.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="merge-dup" className="text-xs font-medium text-secondary">
            Duplicate account
          </label>
          <AccountPicker id="merge-dup" value={dup} onChange={setDup} excludeId={account.id} placeholder="Search the duplicate…" />
          {dup ? (
            <p className="text-sm text-secondary">
              <span className="text-fg">{dup.name}</span> will be merged into <span className="text-fg">{account.name}</span>. Existing values here win; empty fields are filled from the duplicate.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!dup || busy}
            onClick={async () => {
              if (!dup) return;
              setBusy(true);
              const res = await mergeAccountInto({ targetId: account.id, sourceId: dup.id });
              setBusy(false);
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              const moved = Object.entries(res.data.moved)
                .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}${v === 1 ? "" : "s"}`)
                .join(", ");
              toast.success(`Merged ${dup.name}${moved ? ` — moved ${moved}` : ""}`);
              setOpen(false);
              router.refresh();
            }}
          >
            {busy ? "Merging…" : "Merge accounts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
