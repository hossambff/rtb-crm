"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ExternalLink, Plus, Search, Trash2 } from "lucide-react";
import { Badge, ColorTick, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { fmtDate, fmtUsd } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { Field } from "./field";
import { deleteInterview, saveInterview, setR100Stage, updateR100 } from "@/lib/r100/actions";
import { INTERVIEW_STATUSES, interviewOverdue, type Interview, type InterviewStatus, type R100Json } from "@/lib/r100/calc";
import type { R100Row } from "@/lib/r100/queries";

type Stage = { id: string; key: string; name: string; category: string };

export function R100Table({ rows, stages, initialQuery = "", initialStage = "all" }: { rows: R100Row[]; stages: Stage[]; initialQuery?: string; initialStage?: string }) {
  const [q, setQ] = React.useState(initialQuery);
  const [stageFilter, setStageFilter] = React.useState(initialStage);
  // QA-25: keep ?q= / ?stage= in the URL (shareable, survives reload) without a server round-trip.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set("q", q.trim());
    else url.searchParams.delete("q");
    if (stageFilter !== "all") url.searchParams.set("stage", stageFilter);
    else url.searchParams.delete("stage");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [q, stageFilter]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(100);
  const filtered = rows.filter((r) => {
    if (stageFilter === "live" && !r.live) return false;
    if (stageFilter !== "all" && stageFilter !== "live" && r.stageId !== stageFilter) return false;
    if (!q) return true;
    const hay = `${r.company} ${r.ticker ?? ""} ${r.tokenName ?? ""} ${r.category ?? ""} ${r.ownerName ?? ""}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input aria-label="Search companies" placeholder="Search company, ticker, token…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <NativeSelect aria-label="Filter by stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="w-auto min-w-44">
          <option value="all">All stages</option>
          <option value="live">Live only</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
        <span className="ml-auto text-xs text-muted tabular">
          {filtered.length} of {rows.length}
        </span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title={rows.length ? "No companies match" : "No Roundtable 100 companies yet"}
          description={rows.length ? "Try a different search or stage filter." : "R100 deals you can see appear here once they are added to the Roundtable 100 pipeline."}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Category</th>
                <th className="px-2 py-2 font-medium">Owner</th>
                <th className="px-2 py-2 font-medium">Stage</th>
                <th className="px-2 py-2 font-medium">First post</th>
                <th className="px-2 py-2 font-medium">Month 1 · 2 · 3</th>
                <th className="px-2 py-2 font-medium">This month</th>
                <th className="px-2 py-2 font-medium">Posts</th>
                <th className="px-2 py-2 font-medium">Profile</th>
                <th className="px-2 py-2 font-medium">Interview</th>
                <th className="px-2 py-2 font-medium">Bonus</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, limit).map((r) => (
                <Row key={r.id} row={r} stages={stages} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > limit ? (
        <div className="mt-3 flex justify-center">
          <Button size="sm" onClick={() => setLimit(limit + 200)}>
            Show more ({filtered.length - limit} remaining)
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ row, stages, open, onToggle }: { row: R100Row; stages: Stage[]; open: boolean; onToggle: () => void }) {
  const [r100, setR100] = React.useState<R100Json>(row.r100);
  const [stageId, setStageId] = React.useState(row.stageId);
  const [pending, start] = React.useTransition();
  // Re-sync local optimistic state when the server sends fresh props (after revalidation).
  const [synced, setSynced] = React.useState(row);
  if (synced !== row) {
    setSynced(row);
    setR100(row.r100);
    setStageId(row.stageId);
  }

  const save = (patch: Partial<R100Json> & { firstPostDate?: string | null }) => {
    const prev = r100;
    setR100({ ...r100, ...patch });
    start(async () => {
      const res = await updateR100({ dealId: row.id, patch: patch as never });
      if (!res.ok) {
        setR100(prev);
        toast.error(res.error);
      } else setR100(res.data);
    });
  };

  const changeStage = (id: string) => {
    const prev = stageId;
    setStageId(id);
    start(async () => {
      const res = await setR100Stage({ dealId: row.id, stageId: id });
      if (!res.ok) {
        setStageId(prev);
        toast.error(res.error);
      } else if (res.data.changed) {
        toast.success(`Moved to ${stages.find((s) => s.id === id)?.name ?? "stage"}`);
        if (res.data.firstPostDate && !r100.firstPostDate) setR100({ ...r100, firstPostDate: res.data.firstPostDate });
      }
    });
  };

  const participation = [0, 1, 2].map((i) => Boolean(r100.participation?.[i]));
  const ro = !row.canEdit;

  return (
    <>
      <tr className={cn("border-t border-border align-middle transition-colors hover:bg-surface-1", pending && "opacity-70")}>
        <td className="px-2 py-2">
          <button type="button" onClick={onToggle} aria-label={open ? "Hide interviews" : "Show interviews"} aria-expanded={open} className="rounded p-1 text-muted hover:text-fg">
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-2">
            <ColorTick color={PIPELINE_COLORS.R100!} />
            <div className="min-w-0">
              <p className="truncate font-medium text-fg">{row.company}</p>
              <p className="text-[11px] text-muted">
                {[row.ticker, row.tokenName].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
          </div>
        </td>
        <td className="max-w-40 truncate px-2 py-2 text-secondary">{row.category ?? "—"}</td>
        <td className="px-2 py-2 text-secondary">{row.ownerName ?? "Unassigned"}</td>
        <td className="px-2 py-2">
          {ro ? (
            <span className="text-body">{row.stageName}</span>
          ) : (
            <NativeSelect aria-label={`Stage for ${row.company}`} value={stageId} onChange={(e) => changeStage(e.target.value)} className="h-8 w-44 text-xs">
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </td>
        <td className="px-2 py-2">
          {ro ? (
            <span className="tabular">{fmtDate(r100.firstPostDate)}</span>
          ) : (
            <Input
              type="date"
              aria-label={`First post date for ${row.company}`}
              defaultValue={r100.firstPostDate ?? ""}
              key={r100.firstPostDate ?? "none"}
              onBlur={(e) => e.target.value !== (r100.firstPostDate ?? "") && save({ firstPostDate: e.target.value || null })}
              className="h-8 w-36 text-xs"
            />
          )}
        </td>
        <td className="px-2 py-2">
          <div className="flex gap-1">
            {participation.map((on, i) => (
              <button
                key={i}
                type="button"
                disabled={ro}
                aria-pressed={on}
                aria-label={`Month ${i + 1} participation`}
                onClick={() => save({ participation: participation.map((p, j) => (j === i ? !p : p)) })}
                className={cn(
                  "h-7 w-8 rounded border text-xs font-medium tabular transition-colors",
                  on ? "border-white bg-white text-accent-inverse" : "border-border-strong text-muted hover:text-fg",
                  ro && "cursor-default",
                )}
              >
                M{i + 1}
              </button>
            ))}
          </div>
        </td>
        <td className="px-2 py-2">
          <ParticipationBadge state={row.participationNow} />
        </td>
        <td className="px-2 py-2">
          {ro ? (
            <span className="tabular">{r100.postCount ?? 0}</span>
          ) : (
            <Input
              type="number"
              min={0}
              aria-label={`Post count for ${row.company}`}
              defaultValue={r100.postCount ?? 0}
              key={`pc-${r100.postCount ?? 0}`}
              onBlur={(e) => Number(e.target.value) !== (r100.postCount ?? 0) && save({ postCount: Math.max(0, Number(e.target.value) || 0) })}
              className="h-8 w-20 text-xs tabular"
            />
          )}
        </td>
        <td className="px-2 py-2">
          <ProfileCell url={r100.profileUrl ?? null} readOnly={ro} company={row.company} onSave={(v) => save({ profileUrl: v })} />
        </td>
        <td className="px-2 py-2">
          <InterviewBadge status={row.interviewStatus as InterviewStatus | null} count={row.interviews.length} />
        </td>
        <td className="px-2 py-2">
          <BonusCell r100={r100} readOnly={ro} company={row.company} onSave={save} />
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-border bg-surface-1/60">
          <td />
          <td colSpan={11} className="px-2 py-4">
            <Interviews dealId={row.id} company={row.company} interviews={row.interviews} readOnly={ro} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ParticipationBadge({ state }: { state: R100Row["participationNow"] }) {
  if (state === "posted") return <StatusBadge status="good" label="Posted" />;
  if (state === "missing") return <StatusBadge status="warning" label="Not yet" />;
  if (state === "beyond") return <Badge>Month 4+</Badge>;
  return <span className="text-xs text-muted">Not live</span>;
}

function InterviewBadge({ status, count }: { status: InterviewStatus | null; count: number }) {
  if (!status) return <span className="text-xs text-muted">None</span>;
  const label = `${status[0]!.toUpperCase()}${status.slice(1)}${count > 1 ? ` (${count})` : ""}`;
  if (status === "published") return <StatusBadge status="good" label={label} />;
  if (status === "rescheduling") return <StatusBadge status="serious" label={label} />;
  if (status === "filmed") return <StatusBadge status="warning" label={label} />;
  return <Badge>{label}</Badge>;
}

function ProfileCell({ url, readOnly, company, onSave }: { url: string | null; readOnly: boolean; company: string; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = React.useState(false);
  if (editing && !readOnly)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = String(new FormData(e.currentTarget).get("url") ?? "").trim();
          if (v && !/^https?:\/\//i.test(v)) {
            toast.error("Profile link must start with http:// or https://");
            return;
          }
          onSave(v || null);
          setEditing(false);
        }}
        className="flex items-center gap-1"
      >
        <Input name="url" type="url" defaultValue={url ?? ""} autoFocus aria-label={`Profile link for ${company}`} placeholder="https://" className="h-8 w-44 text-xs" />
        <Button size="sm" type="submit">
          Save
        </Button>
      </form>
    );
  return (
    <div className="flex items-center gap-1">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg underline-offset-2 hover:underline">
          Profile <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : (
        <span className="text-xs text-muted">—</span>
      )}
      {!readOnly ? (
        <button type="button" onClick={() => setEditing(true)} className="text-[11px] text-muted hover:text-fg">
          {url ? "Edit" : "Add"}
        </button>
      ) : null}
    </div>
  );
}

function BonusCell({ r100, readOnly, company, onSave }: { r100: R100Json; readOnly: boolean; company: string; onSave: (p: Partial<R100Json>) => void }) {
  const eligible = Boolean(r100.bonusEligible);
  if (readOnly) return <span className="text-xs text-secondary">{eligible ? `Eligible · ${fmtUsd(r100.bonusCents ?? 0, { cents: true })}` : "—"}</span>;
  return (
    <div className="flex items-center gap-1.5">
      <label className="inline-flex items-center gap-1.5 text-xs text-secondary">
        <input type="checkbox" checked={eligible} onChange={(e) => onSave({ bonusEligible: e.target.checked })} className="size-3.5 accent-white" aria-label={`Bonus eligible for ${company}`} />
        Eligible
      </label>
      {eligible ? (
        <Input
          type="number"
          min={0}
          step={100}
          aria-label={`Bonus amount (USD) for ${company}`}
          defaultValue={(r100.bonusCents ?? 0) / 100}
          key={`b-${r100.bonusCents ?? 0}`}
          onBlur={(e) => {
            const cents = Math.round((Number(e.target.value) || 0) * 100);
            if (cents !== (r100.bonusCents ?? 0)) onSave({ bonusCents: cents });
          }}
          className="h-8 w-24 text-xs tabular"
        />
      ) : null}
    </div>
  );
}

const EMPTY_IV = { guest: "", host: "", status: "scheduled" as InterviewStatus, filmedAt: "", publishAt: "", link: "" };

function Interviews({ dealId, company, interviews, readOnly }: { dealId: string; company: string; interviews: Interview[]; readOnly: boolean }) {
  const [editing, setEditing] = React.useState<(typeof EMPTY_IV & { id?: string }) | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const now = new Date();

  const submit = () => {
    if (!editing) return;
    start(async () => {
      const res = await saveInterview({ dealId, interview: editing });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success("Interview saved");
      setEditing(null);
      setErrors({});
    });
  };
  const remove = (id: string) =>
    start(async () => {
      const res = await deleteInterview({ dealId, interviewId: id });
      if (!res.ok) toast.error(res.error);
      else toast.success("Interview removed");
    });

  return (
    <div className="max-w-4xl">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-display text-base text-fg">Interviews · {company}</p>
        {!readOnly && !editing ? (
          <Button size="sm" onClick={() => setEditing({ ...EMPTY_IV })}>
            <Plus /> Add interview
          </Button>
        ) : null}
      </div>
      {interviews.length === 0 && !editing ? <p className="text-xs text-muted">No interviews recorded.</p> : null}
      {interviews.length ? (
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-2 font-medium">Guest</th>
              <th className="py-1 pr-2 font-medium">Host</th>
              <th className="py-1 pr-2 font-medium">Status</th>
              <th className="py-1 pr-2 font-medium">Filmed</th>
              <th className="py-1 pr-2 font-medium">Publish</th>
              <th className="py-1 pr-2 font-medium">Link</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {interviews.map((iv) => (
              <tr key={iv.id} className="border-t border-border">
                <td className="py-1.5 pr-2 text-body">{iv.guest}</td>
                <td className="py-1.5 pr-2 text-secondary">{iv.host || "—"}</td>
                <td className="py-1.5 pr-2">
                  <InterviewBadge status={iv.status} count={1} />
                  {interviewOverdue(iv, now) ? <StatusBadge status="serious" label="Publish date overdue" className="ml-1" /> : null}
                </td>
                <td className="py-1.5 pr-2 tabular">{fmtDate(iv.filmedAt)}</td>
                <td className="py-1.5 pr-2 tabular">{iv.publishAt ? fmtDate(iv.publishAt) : "TBD"}</td>
                <td className="py-1.5 pr-2">
                  {iv.link ? (
                    <a href={iv.link} target="_blank" rel="noreferrer" className="text-fg underline-offset-2 hover:underline">
                      Open
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {!readOnly ? (
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ ...iv, filmedAt: iv.filmedAt ?? "", publishAt: iv.publishAt ?? "", link: iv.link ?? "" })}>
                        Edit
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Delete interview with ${iv.guest}`} disabled={pending} onClick={() => remove(iv.id)}>
                        <Trash2 />
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {editing ? (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-border bg-surface-2 p-3 md:grid-cols-6">
          <Field label="Guest" error={errors["interview"]?.[0]} className="col-span-2">
            <Input value={editing.guest} onChange={(e) => setEditing({ ...editing, guest: e.target.value })} placeholder="Name, title" />
          </Field>
          <Field label="Host">
            <Input value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value })} />
          </Field>
          <Field label="Status">
            <NativeSelect value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as InterviewStatus })}>
              {INTERVIEW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Filmed">
            <Input type="date" value={editing.filmedAt} onChange={(e) => setEditing({ ...editing, filmedAt: e.target.value })} />
          </Field>
          <Field label="Publish (empty = TBD)">
            <Input type="date" value={editing.publishAt} onChange={(e) => setEditing({ ...editing, publishAt: e.target.value })} />
          </Field>
          <Field label="Link" className="col-span-2 md:col-span-4">
            <Input type="url" value={editing.link} onChange={(e) => setEditing({ ...editing, link: e.target.value })} placeholder="https://" />
          </Field>
          <div className="col-span-2 flex items-end justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={pending || !editing.guest.trim()} onClick={submit}>
              Save interview
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
