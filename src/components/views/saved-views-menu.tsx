"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bookmark, Check, Plus, Settings2, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteView, listViews, rememberView, saveView, setDefaultView } from "@/lib/views/actions";
import { listHref, sameParams, sanitizeParams, toQueryString } from "@/lib/views/core";
import type { SavedView } from "@/lib/views/queries";

/**
 * Saved views for a list page (V2 §B8). Drop it next to a page's filters:
 *   <Suspense><SavedViewsMenu page="accounts" /></Suspense>
 * It remembers the last-used filters for the page (pair with `resolveListView` on the server), lets the user save,
 * apply, default and delete named views. All state is the signed-in user's own.
 */
export function SavedViewsMenu({ page, className }: { page: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const current = useMemo(() => sanitizeParams(new URLSearchParams(sp.toString())), [sp]);
  const currentKey = JSON.stringify(current);
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    listViews({ page }).then((r) => alive && setViews(r.ok ? r.data : []));
    return () => {
      alive = false;
    };
  }, [page]);

  // Remember the last-used filters (debounced; failures are silent — this is a convenience).
  const first = useRef(true);
  useEffect(() => {
    const delay = first.current ? 1500 : 700;
    first.current = false;
    const t = setTimeout(() => void rememberView({ page, params: JSON.parse(currentKey) }).catch(() => {}), delay);
    return () => clearTimeout(t);
  }, [page, currentKey]);

  const active = views?.find((v) => sameParams(v.params, current)) ?? null;
  const apply = (params: Record<string, string>) => router.push(listHref(pathname, toQueryString(params)));
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong.");
      else if (done) toast.success(done);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={className} aria-label={`Saved views${active ? `: ${active.name}` : ""}`}>
            <Bookmark /> <span className="max-w-32 truncate">{active ? active.name : "Views"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {views === null ? (
            <p className="px-2 py-1.5 text-xs text-muted">Loading views…</p>
          ) : views.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted">No saved views yet. Filter the list, then save it here.</p>
          ) : (
            views.map((v) => (
              <DropdownMenuItem key={v.id} onSelect={() => apply(v.params)}>
                {active?.id === v.id ? <Check /> : <span className="size-4" aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
                {v.isDefault ? <Star className="text-muted" aria-label="Default view" /> : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setName(active?.name ?? "");
              setAsDefault(false);
              setError(null);
              setSaveOpen(true);
            }}
          >
            <Plus /> Save current view…
          </DropdownMenuItem>
          {views?.length ? (
            <DropdownMenuItem onSelect={() => setManageOpen(true)}>
              <Settings2 /> Manage views…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>Keeps the current filters and sorting so you can come back in one click.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await saveView({ page, name, params: current, isDefault: asDefault });
                if (!r.ok) return setError(r.fieldErrors?.name?.[0] ?? r.error);
                setViews(r.data.views);
                setSaveOpen(false);
                toast.success(`Saved “${name.trim()}”`);
              });
            }}
          >
            <DialogBody>
              <div className="space-y-1.5">
                <Label htmlFor="view-name">Name</Label>
                <Input id="view-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. My NET deals closing this quarter" autoFocus aria-invalid={Boolean(error)} aria-describedby={error ? "view-name-error" : undefined} />
                {error ? (
                  <p id="view-name-error" className="text-xs text-critical">
                    {error}
                  </p>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-sm text-body">
                <input type="checkbox" className="size-4 accent-white" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
                Open this page with this view
              </label>
              {Object.keys(current).length === 0 ? <p className="text-xs text-muted">No filters are applied — this view shows everything.</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={pending || !name.trim()}>
                {pending ? "Saving…" : "Save view"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your views</DialogTitle>
            <DialogDescription>The starred view opens by default; otherwise the page remembers what you used last.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="-my-2 divide-y divide-border">
              {(views ?? []).map((v) => (
                <li key={v.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-body">{v.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={v.isDefault}
                    aria-label={v.isDefault ? `Stop opening with ${v.name}` : `Open the page with ${v.name}`}
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const r = await setDefaultView({ page, id: v.isDefault ? null : v.id });
                        if (r.ok) setViews(r.data.views);
                        return r;
                      })
                    }
                  >
                    <Star className={v.isDefault ? "fill-white text-fg" : ""} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${v.name}`}
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const r = await deleteView({ page, id: v.id });
                        if (r.ok) setViews(r.data.views);
                        return r;
                      }, `Deleted “${v.name}”`)
                    }
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
