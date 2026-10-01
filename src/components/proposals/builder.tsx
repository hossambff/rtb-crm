"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/r100/field";
import { fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { createProposal, updateProposal } from "@/lib/proposals/actions";
import {
  approvalTriggers,
  COST_FUNCTION_LABELS,
  COST_FUNCTIONS,
  computeProForma,
  REVENUE_LINE_LABELS,
  REVENUE_LINES,
  type ApprovalRules,
  type CostFunction,
  type GuaranteeType,
  type ProFormaInputs,
  type RevenueLine,
  usdK,
} from "@/lib/proposals/calc";
import { NY_POST_FIXTURE } from "@/lib/proposals/fixtures";
import type { PrefillItem } from "@/lib/proposals/prefill";

/** Money inputs are entered in $000s (the playbook convention) and stored in whole USD. */
const K = 1000;
const toK = (usd: number) => (usd ? String(Math.round((usd / K) * 1000) / 1000) : "");
const fromK = (v: string) => Math.max(0, Number(v || 0) * K);
const toPct = (p: number) => String(Math.round(p * 10000) / 100);
const fromPct = (v: string) => Math.min(1, Math.max(0, Number(v || 0) / 100));

type Props = {
  mode: "create" | "edit";
  dealId: string;
  proposalId?: string;
  initial: ProFormaInputs;
  readOnly?: boolean;
  rules: ApprovalRules;
  /** A6: fields prefilled from the deal (shown so the rep knows what to review). */
  prefilled?: PrefillItem[];
};

export function ProFormaBuilder({ mode, dealId, proposalId, initial, readOnly, rules, prefilled }: Props) {
  const router = useRouter();
  const [i, setI] = React.useState<ProFormaInputs>(initial);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const [dirty, setDirty] = React.useState(false);
  const out = React.useMemo(() => computeProForma(i), [i]);
  const triggers = React.useMemo(() => approvalTriggers(i, rules), [i, rules]);
  const set = (patch: Partial<ProFormaInputs>) => {
    setI({ ...i, ...patch });
    setDirty(true);
  };

  const save = () =>
    start(async () => {
      const res = mode === "create" ? await createProposal({ dealId, inputs: i }) : await updateProposal({ id: proposalId!, inputs: i });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return void toast.error(res.error);
      }
      setErrors({});
      setDirty(false);
      const reasons = res.data.reasons;
      toast.success(reasons.length ? "Saved · sent for executive approval" : "Saved");
      if (mode === "create") router.push(`/proposals/${res.data.id}`);
      else router.refresh();
    });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <fieldset disabled={readOnly || pending} className="min-w-0 space-y-6">
        <legend className="sr-only">Pro forma inputs</legend>
        {prefilled?.length && !readOnly ? (
          <div className="rounded-lg border border-border bg-surface-1 px-4 py-3 text-sm">
            <p className="font-medium text-fg">Prefilled from the deal: review before saving</p>
            <ul className="mt-1.5 grid gap-x-6 gap-y-0.5 text-xs text-secondary sm:grid-cols-2">
              {prefilled.map((f) => (
                <li key={f.field}>
                  <span className="text-muted">{f.label}:</span> {f.value}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (dirty && !window.confirm("Replace current inputs with the NY Post reference scenario?")) return;
                set({ ...NY_POST_FIXTURE });
              }}
            >
              Load NY Post reference scenario
            </Button>
            <span className="text-xs text-muted">All money inputs in $000s, annual.</span>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Client revenue</CardTitle>
              <CardDescription>By line, trailing 12 months. Tick the lines the revenue share applies to.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Field label="Scenario label">
              <Input value={i.scenarioLabel ?? ""} onChange={(e) => set({ scenarioLabel: e.target.value })} placeholder="e.g. $250M scenario, held flat" />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_96px_64px] items-center gap-x-3 gap-y-2 pt-2 text-sm sm:grid-cols-[1fr_120px_90px]">
              <span className="text-xs text-muted">Line</span>
              <span className="text-right text-xs text-muted">$000s</span>
              <span className="text-center text-xs text-muted">Rev share</span>
              {REVENUE_LINES.map((line) => (
                <React.Fragment key={line}>
                  <label htmlFor={`rev-${line}`} className="text-body">
                    {REVENUE_LINE_LABELS[line]}
                  </label>
                  <Input
                    id={`rev-${line}`}
                    type="number"
                    min={0}
                    step="any"
                    className="text-right tabular"
                    value={toK(i.revenue[line])}
                    onChange={(e) => set({ revenue: { ...i.revenue, [line]: fromK(e.target.value) } })}
                  />
                  <span className="flex justify-center">
                    <input
                      type="checkbox"
                      aria-label={`Revenue share applies to ${REVENUE_LINE_LABELS[line]}`}
                      className="size-4 accent-white"
                      checked={i.revShareLines.includes(line)}
                      onChange={(e) =>
                        set({ revShareLines: e.target.checked ? [...i.revShareLines, line] : i.revShareLines.filter((l: RevenueLine) => l !== line) })
                      }
                    />
                  </span>
                </React.Fragment>
              ))}
              <span className="border-t border-border pt-2 font-medium text-fg">Total revenue</span>
              <span className="border-t border-border pt-2 text-right font-medium text-fg tabular">{usdK(out.revenueTotal)}</span>
              <span className="border-t border-border pt-2 text-center text-xs text-muted tabular">{usdK(out.inScopeRevenue)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Cost stack</CardTitle>
              <CardDescription>By function or vendor. RTB-funded % is the share of each line RTB takes over (100% = zeroed on the client P&L).</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {errors.inputs?.[0] ? <p className="mb-2 text-[11px] text-critical">{errors.inputs[0]}</p> : null}
            <div className="space-y-2">
              <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_110px_90px_32px] gap-2 text-xs text-muted md:grid">
                <span>Line</span>
                <span>Function</span>
                <span className="text-right">$000s</span>
                <span className="text-right">RTB-funded %</span>
                <span />
              </div>
              {i.costs.map((c, idx) => (
                <div key={idx} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_110px_90px_32px] md:border-0 md:p-0">
                  <Input
                    aria-label="Cost line name"
                    value={c.label}
                    onChange={(e) => set({ costs: i.costs.map((x, j) => (j === idx ? { ...x, label: e.target.value } : x)) })}
                    className="col-span-2 md:col-span-1"
                  />
                  <NativeSelect aria-label="Function" value={c.fn} onChange={(e) => set({ costs: i.costs.map((x, j) => (j === idx ? { ...x, fn: e.target.value as CostFunction } : x)) })}>
                    {COST_FUNCTIONS.map((f) => (
                      <option key={f} value={f}>
                        {COST_FUNCTION_LABELS[f]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    aria-label="Annual cost ($000s)"
                    type="number"
                    min={0}
                    step="any"
                    className="text-right tabular"
                    value={toK(c.amount)}
                    onChange={(e) => set({ costs: i.costs.map((x, j) => (j === idx ? { ...x, amount: fromK(e.target.value) } : x)) })}
                  />
                  <Input
                    aria-label="RTB-funded percent"
                    type="number"
                    min={0}
                    max={100}
                    className="text-right tabular"
                    value={toPct(c.rtbFundedPct)}
                    onChange={(e) => set({ costs: i.costs.map((x, j) => (j === idx ? { ...x, rtbFundedPct: fromPct(e.target.value) } : x)) })}
                  />
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${c.label}`} onClick={() => set({ costs: i.costs.filter((_, j) => j !== idx) })} className="self-center">
                    <Trash2 />
                  </Button>
                </div>
              ))}
              {!readOnly ? (
                <Button size="sm" onClick={() => set({ costs: [...i.costs, { label: "New cost line", fn: "other", amount: 0, rtbFundedPct: 0 }] })}>
                  <Plus /> Add cost line
                </Button>
              ) : null}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 md:grid-cols-4">
              <Field label="S&M cost ($000s)">
                <Input type="number" min={0} step="any" className="tabular" value={toK(i.smCost)} onChange={(e) => set({ smCost: fromK(e.target.value) })} />
              </Field>
              <Field label="S&M absorbed by RTB (%)">
                <Input type="number" min={0} max={100} className="tabular" value={toPct(i.smAbsorbPct)} onChange={(e) => set({ smAbsorbPct: fromPct(e.target.value) })} />
              </Field>
              <Field label="G&A cost ($000s)">
                <Input type="number" min={0} step="any" className="tabular" value={toK(i.gaCost)} onChange={(e) => set({ gaCost: fromK(e.target.value) })} />
              </Field>
              <Field label="G&A absorbed by RTB (%)">
                <Input type="number" min={0} max={100} className="tabular" value={toPct(i.gaAbsorbPct)} onChange={(e) => set({ gaAbsorbPct: fromPct(e.target.value) })} />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Partnership terms</CardTitle>
              <CardDescription>
                Executive approval is required below a {fmtPct(rules.minRevSharePct)} share, above {usdK(rules.maxGuaranteeMonthlyUsd)}/month of guarantee, or beyond {rules.maxTermYears} years.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            <Field label="RTB revenue share (%)" error={errors.revSharePct?.[0]}>
              <Input type="number" min={0} max={100} step="any" className="tabular" value={toPct(i.revSharePct)} onChange={(e) => set({ revSharePct: fromPct(e.target.value) })} />
            </Field>
            <Field label="Guarantee type">
              <NativeSelect value={i.guaranteeType} onChange={(e) => set({ guaranteeType: e.target.value as GuaranteeType })}>
                <option value="profit_floor">Profit floor (≥ today&apos;s EBITDA)</option>
                <option value="fixed_monthly">Fixed $/month</option>
                <option value="none">None</option>
              </NativeSelect>
            </Field>
            <Field
              label={i.guaranteeType === "fixed_monthly" ? "Guarantee ($000s / month)" : "Annual floor ($000s)"}
              hint={i.guaranteeType === "profit_floor" ? "Empty = today's EBITDA" : undefined}
            >
              <Input type="number" min={0} step="any" disabled={i.guaranteeType === "none"} className="tabular" value={toK(i.guaranteeAmount)} onChange={(e) => set({ guaranteeAmount: fromK(e.target.value) })} />
            </Field>
            <Field label="Ramp (months at 100% to partner)" error={errors.rampMonths?.[0]}>
              <Input type="number" min={0} max={24} className="tabular" value={String(i.rampMonths)} onChange={(e) => set({ rampMonths: Math.max(0, Math.round(Number(e.target.value || 0))) })} />
            </Field>
            <Field label="Term (years)" error={errors.termYears?.[0]}>
              <Input type="number" min={1} max={20} step={0.5} className="tabular" value={String(i.termYears)} onChange={(e) => set({ termYears: Number(e.target.value || 1) })} />
            </Field>
            <Field label="In-scope growth per year (%)">
              <Input type="number" min={-50} max={100} step="any" className="tabular" value={String(Math.round(i.growthPct * 10000) / 100)} onChange={(e) => set({ growthPct: Number(e.target.value || 0) / 100 })} />
            </Field>
            <Field label="Internal notes" className="sm:col-span-2 md:col-span-3">
              <Textarea rows={2} value={i.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Assumptions & sources (not printed)" />
            </Field>
          </CardContent>
        </Card>
      </fieldset>

      <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
        <Outputs out={out} />
        {triggers.length ? (
          <div className="space-y-1 rounded-lg border border-border bg-surface-1 p-4">
            <p className="text-xs font-medium text-secondary">Needs executive approval before export</p>
            {triggers.map((t) => (
              <StatusBadge key={t} status="warning" label={t} />
            ))}
          </div>
        ) : null}
        {!readOnly ? (
          <div className="flex justify-end gap-2">
            <Button variant="primary" disabled={pending || (mode === "edit" && !dirty)} onClick={save}>
              {pending ? "Saving…" : mode === "create" ? "Create version 1" : "Save changes"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Outputs({ out }: { out: ReturnType<typeof computeProForma> }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Client EBITDA</CardTitle>
          <CardDescription>Steady state, full year after ramp, before growth.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Hero label="Today" value={usdK(out.clientEbitdaBefore)} hint={`${fmtPct(out.marginBefore, 1)} margin`} />
          <Hero label="With Roundtable (before share)" value={usdK(out.clientEbitdaAfter)} hint={`${fmtPct(out.marginAfter, 1)} margin${out.ebitdaMultiple ? ` · ${out.ebitdaMultiple.toFixed(2)}x` : ""}`} />
          <Hero label="Uplift (RTB-funded cost)" value={`+${usdK(out.uplift)}`} hint={`${usdK(out.platformFunded)} platform · ${usdK(out.smAbsorbed + out.gaAbsorbed + out.otherFunded)} teams & overhead`} />
          <Hero label="Client net after share" value={usdK(out.clientNetAfterShare)} hint={`${out.clientNetUplift >= 0 ? "+" : ""}${usdK(out.clientNetUplift)} vs today`} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-sm tabular">
          <dt className="text-secondary">RTB share / yr</dt>
          <dd className="text-right text-fg">{usdK(out.rtbShare)}</dd>
          <dt className="text-secondary">Guarantee floor / yr</dt>
          <dd className="text-right text-fg">{usdK(out.guaranteeFloorAnnual)}</dd>
          <dt className="text-secondary">Guarantee exposure / yr</dt>
          <dd className={cn("text-right", out.guaranteeExposure > 0 ? "text-fg" : "text-muted")}>{usdK(out.guaranteeExposure)}</dd>
        </dl>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="table-sticky-first w-full min-w-[440px] text-xs tabular">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Year</th>
                <th className="py-1 pr-2 text-right font-medium">Revenue</th>
                <th className="py-1 pr-2 text-right font-medium">EBITDA pre-share</th>
                <th className="py-1 pr-2 text-right font-medium">RTB share</th>
                <th className="py-1 pr-2 text-right font-medium">Client net</th>
                <th className="py-1 text-right font-medium">Exposure</th>
              </tr>
            </thead>
            <tbody>
              {out.years.map((y) => (
                <tr key={y.year} className="border-t border-border">
                  <td className="py-1 pr-2">Y{y.year}</td>
                  <td className="py-1 pr-2 text-right">{usdK(y.revenue)}</td>
                  <td className="py-1 pr-2 text-right">{usdK(y.ebitdaAfter)}</td>
                  <td className="py-1 pr-2 text-right">{usdK(y.rtbShare)}</td>
                  <td className="py-1 pr-2 text-right text-fg">{usdK(y.clientNet)}</td>
                  <td className="py-1 text-right">{y.guaranteeExposure ? usdK(y.guaranteeExposure) : "—"}</td>
                </tr>
              ))}
              <tr className="border-t border-border-strong font-medium text-fg">
                <td className="py-1 pr-2">Term</td>
                <td />
                <td />
                <td className="py-1 pr-2 text-right">{usdK(out.totals.rtbShare)}</td>
                <td className="py-1 pr-2 text-right">{usdK(out.totals.clientNet)}</td>
                <td className="py-1 text-right">{out.totals.guaranteeExposure ? usdK(out.totals.guaranteeExposure) : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted">Figures in $K (thousands). RTB-funded cost over the term: {usdK(out.totals.rtbFunded)}.</p>
      </CardContent>
    </Card>
  );
}

function Hero({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-display text-[clamp(1.125rem,5vw,1.5rem)] leading-tight text-fg tabular">{value}</p>
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
