"use client";
import * as React from "react";
import Link from "next/link";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { clearProbabilityOverride, decideProbabilityOverride, requestProbabilityOverride, updateDealValues, updateR100 } from "@/lib/deals/actions";
import { fmtDate, fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { CHART_AXIS, SEQ_BLUE } from "@/lib/palette";
import { Panel } from "./side-panels";
import { useRun } from "./use-run";

/* ───────────── Generic key/value editor ───────────── */

type FieldDef = { key: string; label: string; kind: "number" | "usd" | "percent" | "date" | "text"; value: number | string | null | undefined; hint?: string };

function display(f: FieldDef) {
  if (f.value == null || f.value === "") return "—";
  switch (f.kind) {
    case "usd":
      return fmtUsd(Number(f.value));
    case "percent":
      return `${Math.round(Number(f.value) * 1000) / 10}%`;
    case "date":
      return fmtDate(String(f.value));
    case "number":
      return fmtNumber(Number(f.value));
    default:
      return String(f.value);
  }
}

function toInput(f: FieldDef): string {
  if (f.value == null) return "";
  if (f.kind === "percent") return String(Math.round(Number(f.value) * 1000) / 10);
  if (f.kind === "date") return String(f.value).slice(0, 10);
  return String(f.value);
}

function FieldsEditor({ title, fields, canEdit, onSave, footer }: { title: string; fields: FieldDef[]; canEdit: boolean; onSave: (vals: Record<string, string>) => void; footer?: React.ReactNode }) {
  const [editing, setEditing] = React.useState(false);
  const [vals, setVals] = React.useState<Record<string, string>>({});
  return (
    <Panel
      title={title}
      action={
        canEdit && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setVals(Object.fromEntries(fields.map((f) => [f.key, toInput(f)])));
              setEditing(true);
            }}
          >
            <Pencil /> Edit
          </Button>
        ) : null
      }
    >
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(vals);
            setEditing(false);
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`fe-${f.key}`}>
                  {f.label}
                  {f.kind === "usd" ? " ($)" : f.kind === "percent" ? " (%)" : ""}
                </Label>
                <Input
                  id={`fe-${f.key}`}
                  type={f.kind === "date" ? "date" : "text"}
                  inputMode={f.kind === "text" || f.kind === "date" ? undefined : "decimal"}
                  value={vals[f.key] ?? ""}
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                  className="h-8 text-[13px] [color-scheme:dark]"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {fields.map((f) => (
            <div key={f.key}>
              <dt className="text-[11px] text-muted">{f.label}</dt>
              <dd className="text-[13px] text-body tabular">{display(f)}</dd>
            </div>
          ))}
        </dl>
      )}
      {footer}
    </Panel>
  );
}

const num = (s: string | undefined) => (s == null || s.trim() === "" ? null : Number(s.replace(/[$,%\s]/g, "")));

/* ───────────── NET / ENT / SPT ───────────── */

export function MuuPanel({
  dealId,
  deal,
  hidden,
  pipelineUsdPerMuu,
  history,
  canEdit,
}: {
  dealId: string;
  deal: { muu: number | null; usdPerMuu: number | null; revSharePct?: number | null; guaranteeType?: string | null; guaranteeMonthlyCents?: number | null; rampMonths?: number | null; termYears?: number | null };
  hidden: string[];
  pipelineUsdPerMuu: number;
  history: { id: string; metric: string; value: number; derivedMuu: number | null; period: string | null; source: string; confidence: string; rawValue: string | null }[];
  canEdit: boolean;
}) {
  const [run, pending] = useRun();
  const fields: FieldDef[] = [
    { key: "muu", label: "MUU", kind: "number", value: deal.muu },
    { key: "usdPerMuu", label: "$ / MUU / yr", kind: "number", value: deal.usdPerMuu ?? null, hint: `Default ${pipelineUsdPerMuu}` },
    ...(!hidden.includes("revSharePct") ? [{ key: "revSharePct", label: "RTB share", kind: "percent" as const, value: deal.revSharePct }] : []),
    ...(!hidden.includes("guaranteeType") ? [{ key: "guaranteeType", label: "Guarantee type", kind: "text" as const, value: deal.guaranteeType }] : []),
    ...(!hidden.includes("guaranteeMonthlyCents") ? [{ key: "guaranteeMonthly", label: "Guarantee / mo", kind: "usd" as const, value: deal.guaranteeMonthlyCents != null ? deal.guaranteeMonthlyCents / 100 : null }] : []),
    ...(!hidden.includes("rampMonths") ? [{ key: "rampMonths", label: "Ramp (months)", kind: "number" as const, value: deal.rampMonths }] : []),
    ...(!hidden.includes("termYears") ? [{ key: "termYears", label: "Term (years)", kind: "number" as const, value: deal.termYears }] : []),
  ];
  const points = history.map((h) => ({ label: h.period ?? "", v: h.derivedMuu ?? (h.metric === "muu" ? h.value : null) })).filter((p): p is { label: string; v: number } => p.v != null);
  return (
    <>
      <FieldsEditor
        title="Terms & audience"
        fields={fields}
        canEdit={canEdit && !pending}
        onSave={(v) =>
          run(
            () =>
              updateDealValues({
                dealId,
                patch: {
                  muu: num(v.muu),
                  usdPerMuu: num(v.usdPerMuu),
                  ...(v.revSharePct !== undefined ? { revSharePct: num(v.revSharePct) } : {}),
                  ...(v.guaranteeType !== undefined ? { guaranteeType: v.guaranteeType || null } : {}),
                  ...(v.guaranteeMonthly !== undefined ? { guaranteeMonthly: num(v.guaranteeMonthly) } : {}),
                  ...(v.rampMonths !== undefined ? { rampMonths: num(v.rampMonths) } : {}),
                  ...(v.termYears !== undefined ? { termYears: num(v.termYears) } : {}),
                },
              }),
            { success: "Terms saved" },
          )
        }
        footer={hidden.includes("revSharePct") ? <p className="mt-2 text-[11px] text-muted">Revenue-share and guarantee terms are hidden for your role.</p> : null}
      />
      <Panel title="MUU history" count={history.length}>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No audience metrics recorded for this account yet.</p>
        ) : (
          <>
            {points.length > 1 ? <Sparkline points={points} /> : null}
            <table className="mt-2 w-full text-[12px] tabular">
              <thead>
                <tr className="text-left text-[11px] text-muted">
                  <th className="py-1 font-medium">Period</th>
                  <th className="py-1 font-medium">Value</th>
                  <th className="py-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {history
                  .slice()
                  .reverse()
                  .slice(0, 8)
                  .map((h) => (
                    <tr key={h.id} className="border-t border-border">
                      <td className="py-1 text-secondary">{h.period ?? "—"}</td>
                      <td className="py-1 text-body" title={h.rawValue ? `Raw: ${h.rawValue}` : undefined}>
                        {fmtNumber(h.derivedMuu ?? h.value, { compact: true })} {h.metric === "muu" ? "MUU" : h.metric}
                      </td>
                      <td className="py-1 text-muted">
                        {h.source} · {h.confidence}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>
    </>
  );
}

function Sparkline({ points }: { points: { label: string; v: number }[] }) {
  const w = 260;
  const h = 48;
  const max = Math.max(...points.map((p) => p.v));
  const min = Math.min(...points.map((p) => p.v));
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 8) + 4, h - 6 - ((p.v - min) / span) * (h - 12)] as const);
  return (
    <figure aria-label={`MUU trend from ${fmtNumber(points[0]!.v, { compact: true })} to ${fmtNumber(points.at(-1)!.v, { compact: true })}`}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" role="img">
        <line x1="0" x2={w} y1={h - 6} y2={h - 6} stroke={CHART_AXIS.grid} />
        <polyline fill="none" stroke={SEQ_BLUE[6]} strokeWidth="2" strokeLinejoin="round" points={xy.map((p) => p.join(",")).join(" ")} />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill={SEQ_BLUE[6]} stroke={CHART_AXIS.surface} strokeWidth="1.5">
            <title>{`${points[i]!.label}: ${fmtNumber(points[i]!.v)}`}</title>
          </circle>
        ))}
      </svg>
    </figure>
  );
}

/* ───────────── ADS ───────────── */

export function AdsPanel({
  dealId,
  deal,
  invoices,
  canEdit,
}: {
  dealId: string;
  deal: { contractValueCents: number | null; annualizedValueCents: number | null; nextPaymentCents: number | null; nextPaymentAt: string | null; renewalAt: string | null };
  invoices: { id: string; amountCents: number; dueAt: string; status: string; paidAt: string | null }[];
  canEdit: boolean;
}) {
  const [run] = useRun();
  const fields: FieldDef[] = [
    { key: "contractValue", label: "Contract value", kind: "usd", value: deal.contractValueCents != null ? deal.contractValueCents / 100 : null },
    { key: "annualizedValue", label: "Annualized", kind: "usd", value: deal.annualizedValueCents != null ? deal.annualizedValueCents / 100 : null },
    { key: "nextPayment", label: "Next payment", kind: "usd", value: deal.nextPaymentCents != null ? deal.nextPaymentCents / 100 : null },
    { key: "nextPaymentAt", label: "Next payment date", kind: "date", value: deal.nextPaymentAt },
    { key: "renewalAt", label: "Renewal", kind: "date", value: deal.renewalAt },
  ];
  const statusOf = (s: string) => (s === "paid" ? "good" : s === "overdue" ? "critical" : s === "written_off" ? "serious" : "warning") as "good";
  return (
    <FieldsEditor
      title="Billing & collections"
      fields={fields}
      canEdit={canEdit}
      onSave={(v) =>
        run(
          () =>
            updateDealValues({
              dealId,
              patch: { contractValue: num(v.contractValue), annualizedValue: num(v.annualizedValue), nextPayment: num(v.nextPayment), nextPaymentAt: v.nextPaymentAt || null, renewalAt: v.renewalAt || null },
            }),
          { success: "Billing saved" },
        )
      }
      footer={
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Invoices</p>
          {invoices.length ? (
            <ul className="space-y-1">
              {invoices.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-[12px] tabular">
                  <span className="text-body">{fmtUsd(i.amountCents, { cents: true })}</span>
                  <span className="text-muted">due {fmtDate(i.dueAt)}</span>
                  <StatusBadge status={statusOf(i.status)} label={i.status.replace("_", " ")} className="ml-auto capitalize" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted">An invoice is scheduled automatically when this deal is won with a next payment amount and date.</p>
          )}
          <Link href="/revenue" className="mt-2 inline-block text-[11px] text-secondary hover:text-fg">
            Open Revenue →
          </Link>
        </div>
      }
    />
  );
}

/* ───────────── R100 ───────────── */

type R100 = { firstPostDate?: string | null; participation?: boolean[]; postCount?: number; profileUrl?: string | null; editorialLinks?: string[]; bonusEligible?: boolean };

export function R100Panel({ dealId, r100, canEdit }: { dealId: string; r100: R100; canEdit: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<R100>(r100);
  const [links, setLinks] = React.useState((r100.editorialLinks ?? []).join("\n"));
  const [run, pending] = useRun();
  const part = [0, 1, 2].map((i) => r100.participation?.[i] ?? false);
  return (
    <Panel
      title="RTB100 activation"
      action={
        canEdit && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(r100);
              setLinks((r100.editorialLinks ?? []).join("\n"));
              setEditing(true);
            }}
          >
            <Pencil /> Edit
          </Button>
        ) : null
      }
    >
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                updateR100({
                  dealId,
                  r100: {
                    firstPostDate: draft.firstPostDate || null,
                    participation: [0, 1, 2].map((i) => !!draft.participation?.[i]),
                    postCount: Number(draft.postCount ?? 0),
                    profileUrl: draft.profileUrl || "",
                    editorialLinks: links.split(/\s+/).filter(Boolean),
                    bonusEligible: !!draft.bonusEligible,
                  },
                }),
              { success: "RTB100 saved", onOk: () => setEditing(false) },
            );
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="r-first">First post</Label>
              <Input id="r-first" type="date" className="h-8 [color-scheme:dark]" value={draft.firstPostDate?.slice(0, 10) ?? ""} onChange={(e) => setDraft({ ...draft, firstPostDate: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="r-posts">Channel posts</Label>
              <Input id="r-posts" inputMode="numeric" className="h-8" value={String(draft.postCount ?? 0)} onChange={(e) => setDraft({ ...draft, postCount: Number(e.target.value) || 0 })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-url">Profile URL</Label>
            <Input id="r-url" type="url" className="h-8" value={draft.profileUrl ?? ""} onChange={(e) => setDraft({ ...draft, profileUrl: e.target.value })} placeholder="https://roundtable.io/…" />
          </div>
          <fieldset className="flex flex-wrap gap-3 text-[13px]">
            <legend className="mb-1 text-xs font-medium text-secondary">Participation</legend>
            {[0, 1, 2].map((i) => (
              <label key={i} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="size-3.5 accent-white"
                  checked={!!draft.participation?.[i]}
                  onChange={(e) => {
                    const p = [0, 1, 2].map((j) => !!draft.participation?.[j]);
                    p[i] = e.target.checked;
                    setDraft({ ...draft, participation: p });
                  }}
                />
                Month {i + 1}
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="size-3.5 accent-white" checked={!!draft.bonusEligible} onChange={(e) => setDraft({ ...draft, bonusEligible: e.target.checked })} />
              Bonus eligible
            </label>
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="r-links">Editorial links (one per line)</Label>
            <Textarea id="r-links" rows={3} value={links} onChange={(e) => setLinks(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2 text-[13px]">
          <div className="flex gap-1.5">
            {part.map((p, i) => (
              <StatusBadge key={i} status={p ? "good" : "warning"} label={`M${i + 1}`} />
            ))}
            {r100.bonusEligible ? <Badge>Bonus eligible</Badge> : null}
          </div>
          <dl className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-[11px] text-muted">First post</dt>
              <dd className="tabular">{fmtDate(r100.firstPostDate ?? null)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted">Channel posts</dt>
              <dd className="tabular">{r100.postCount ?? 0}</dd>
            </div>
          </dl>
          {r100.profileUrl ? (
            <a href={r100.profileUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-secondary hover:text-fg hover:underline">
              {r100.profileUrl}
            </a>
          ) : null}
          {r100.editorialLinks?.length ? <p className="text-[11px] text-muted">{r100.editorialLinks.length} editorial link(s)</p> : null}
        </div>
      )}
    </Panel>
  );
}

/* ───────────── Probability override (DEAL-4) ───────────── */

export function ProbabilityPanel({
  dealId,
  stageProbability,
  effective,
  override,
  overrideReason,
  overrideStatus,
  pendingSince,
  canEdit,
  isApprover,
}: {
  dealId: string;
  stageProbability: number;
  effective: number;
  override: number | null;
  overrideReason: string | null;
  overrideStatus: string | null;
  pendingSince: string | null;
  canEdit: boolean;
  isApprover: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [pct, setPct] = React.useState(override != null ? String(Math.round(override * 100)) : "");
  const [reason, setReason] = React.useState("");
  const [run, pending] = useRun();
  return (
    <Panel title="Probability">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-3xl text-fg tabular">{fmtPct(effective)}</span>
        <span className="text-xs text-muted">stage default {fmtPct(stageProbability)}</span>
      </div>
      {override != null ? (
        <div className="mt-2 space-y-1 text-[12px]">
          <div className="flex items-center gap-2">
            {overrideStatus === "pending" ? (
              <StatusBadge status="warning" label={`Override ${fmtPct(override)} pending approval`} />
            ) : overrideStatus === "rejected" ? (
              <StatusBadge status="critical" label={`Override ${fmtPct(override)} rejected`} />
            ) : (
              <StatusBadge status="good" label={`Override ${fmtPct(override)} approved`} />
            )}
          </div>
          {overrideReason ? <p className="text-secondary">“{overrideReason}”</p> : null}
          {pendingSince ? <p className="text-muted">Requested {fmtDate(pendingSince)}. Reports use the stage default until an executive approves.</p> : null}
          {isApprover && overrideStatus === "pending" ? (
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => decideProbabilityOverride({ dealId, approve: true }), { success: "Override approved" })}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => decideProbabilityOverride({ dealId, approve: false }), { success: "Override rejected" })}>
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {canEdit ? (
        editing ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => requestProbabilityOverride({ dealId, pct: Number(pct), reason }), {
                success: (d) => (d.status === "pending" ? "Override sent for executive approval" : "Override applied"),
                onOk: () => setEditing(false),
              });
            }}
          >
            <div className="flex items-center gap-2">
              <Input aria-label="Override percent" inputMode="numeric" className="h-8 w-20 tabular" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="%" required />
              <span className="text-xs text-muted">%</span>
            </div>
            <Textarea aria-label="Override reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required) — e.g. verbal commitment from CEO on 28 Sep" required minLength={5} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={pending || reason.trim().length < 5 || pct === "" || Number(pct) < 0 || Number(pct) > 100}>
                {pending ? <Loader2 className="animate-spin" /> : null} {isApprover ? "Apply" : "Request approval"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {override != null ? "Change override" : "Override probability"}
            </Button>
            {override != null ? (
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => clearProbabilityOverride({ dealId }), { success: "Override cleared" })}>
                Clear
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </Panel>
  );
}
