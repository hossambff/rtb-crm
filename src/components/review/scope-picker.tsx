"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { ScopeOptions } from "@/lib/review/queries";
import { scopeToQuery, type ReviewScope } from "@/lib/review/scope";

/** Motions (chips) + team + people → updates the URL; the server rebuilds the exception list. */
export function ScopePicker({ options, scope }: { options: ScopeOptions; scope: ReviewScope }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ReviewScope>(scope);
  const [q, setQ] = useState("");
  const dirty = scopeToQuery(draft) !== scopeToQuery(scope);
  const owners = useMemo(() => options.owners.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase())), [options.owners, q]);
  const ownerLabel = draft.ownerIds.length === 0 ? "Everyone" : draft.ownerIds.length === 1 ? (options.owners.find((o) => o.id === draft.ownerIds[0])?.name ?? "1 person") : `${draft.ownerIds.length} people`;

  function apply(next = draft) {
    const qs = scopeToQuery(next);
    router.push(`/review${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  const togglePipe = (key: string) =>
    setDraft((d) => ({ ...d, pipelineKeys: d.pipelineKeys.includes(key) ? d.pipelineKeys.filter((k) => k !== key) : [...d.pipelineKeys, key] }));
  const toggleOwner = (id: string) => setDraft((d) => ({ ...d, ownerIds: d.ownerIds.includes(id) ? d.ownerIds.filter((x) => x !== id) : [...d.ownerIds, id] }));

  return (
    <form
      className="rounded-lg border border-border bg-surface-1 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="space-y-4">
        <div role="group" aria-labelledby="review-motions" className="min-w-0">
          <p id="review-motions" className="mb-2 text-xs font-medium text-secondary">
            Motions
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={draft.pipelineKeys.length === 0}
              onClick={() => setDraft((d) => ({ ...d, pipelineKeys: [] }))}
              className={cn(
                "touch-target h-8 rounded-full border px-3 text-sm transition-colors duration-150",
                draft.pipelineKeys.length === 0 ? "border-white bg-white text-black" : "border-border text-secondary hover:text-fg",
              )}
            >
              All
            </button>
            {options.pipelines.map((p) => {
              const on = draft.pipelineKeys.includes(p.key);
              return (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => togglePipe(p.key)}
                  title={p.name}
                  className={cn(
                    "touch-target inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150",
                    on ? "border-white bg-white text-black" : "border-border text-secondary hover:text-fg",
                  )}
                >
                  <span aria-hidden className="inline-block h-3 w-1 rounded-full" style={{ background: p.color }} />
                  {p.name === p.key ? p.key : (
                    <>
                      {p.name} <span className="text-xs opacity-60">{p.key}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {options.teams.length > 0 ? (
          <div className="w-full space-y-1.5 sm:w-48">
            <Label htmlFor="review-team">Team</Label>
            <NativeSelect id="review-team" value={draft.teamId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, teamId: e.target.value || null }))}>
              <option value="">Any team</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {options.owners.length > 1 ? (
          <div className="w-full space-y-1.5 sm:w-56">
            <span className="text-xs font-medium text-secondary" id="review-people">
              People
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="secondary" className="w-full justify-between" aria-labelledby="review-people">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Users className="text-muted" />
                    <span className="truncate">{ownerLabel}</span>
                  </span>
                  <ChevronDown className="text-muted" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] p-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" className="mb-2 h-8" />
                {/* QA POL-05: a plain checkbox group (no buttons inside role="option") */}
                <ul className="max-h-64 overflow-y-auto" role="group" aria-label="People">
                  {owners.map((o) => {
                    const on = draft.ownerIds.includes(o.id);
                    return (
                      <li key={o.id}>
                        <label className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm pointer-coarse:py-2.5 text-body hover:bg-surface-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-white">
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleOwner(o.id)} />
                          <span aria-hidden className={cn("flex size-4 items-center justify-center rounded border", on ? "border-white bg-white text-black" : "border-border-strong")}>
                            {on ? <Check className="size-3" /> : null}
                          </span>
                          <span className="truncate">{o.name}</span>
                        </label>
                      </li>
                    );
                  })}
                  {!owners.length ? <li className="px-2 py-1.5 text-sm text-muted">No one matches.</li> : null}
                </ul>
                {draft.ownerIds.length ? (
                  <button type="button" onClick={() => setDraft((d) => ({ ...d, ownerIds: [] }))} className="touch-target mt-2 w-full rounded px-2 py-1 text-left text-xs text-secondary hover:text-fg">
                    Clear — everyone
                  </button>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
        ) : null}

        <Button type="submit" variant={dirty ? "primary" : "secondary"} disabled={!dirty} className="sm:ml-auto">
          Build list
        </Button>
        </div>
      </div>
    </form>
  );
}
