"use client";
import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtDate, fmtUsd } from "@/lib/format";
import { ROLE_LABELS, type Role } from "@/lib/rbac/model";
import { assignPlan, savePlan, unassignPlan } from "@/lib/commissions/actions";
import { RATE_TYPE_LABELS, RATE_TYPES, TRIGGER_LABELS, TRIGGERS, whatIf, type PlanRule, type RateType, type Trigger } from "@/lib/commissions/calc";

const PIPES = ["NET", "ENT", "SPT", "R100", "ADS", "PAY"] as const;
type Plan = { id: string; name: string; description: string | null; active: boolean; rules: PlanRule[] };

export function describeRule(r: PlanRule): string {
  const rate = r.rateType === "flat" ? fmtUsd(r.rate, { cents: true }) : `${r.rate}% ${r.rateType === "pct_net" ? "of RTB net" : "of value"}`;
  const pipes = r.pipelineKeys?.length ? ` · ${r.pipelineKeys.join(", ")}` : "";
  const cap = r.capCents ? ` · cap ${fmtUsd(r.capCents, { cents: true })}/mo` : "";
  const claw = r.clawbackDays ? ` · clawback ${r.clawbackDays}d` : "";
  return `${TRIGGER_LABELS[r.trigger]} → ${rate}${pipes}${cap}${claw}`;
}

export function PlansPanel({ plans, canConfigure }: { plans: Plan[]; canConfigure: boolean }) {
  const [editing, setEditing] = React.useState<Plan | "new" | null>(null);
  return (
    <div className="space-y-3">
      {canConfigure ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus /> New plan
          </Button>
        </div>
      ) : null}
      {plans.length === 0 ? <EmptyState title="No plans" description={canConfigure ? "Create a plan to start accruing." : "No commission plan is assigned to you yet."} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {plans.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  {p.name} {!p.active ? <Badge>Inactive</Badge> : null}
                </CardTitle>
                {p.description ? <CardDescription>{p.description}</CardDescription> : null}
              </div>
              {canConfigure ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  Edit
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm text-body">
                {p.rules.map((r, i) => (
                  <li key={i} className="tabular">
                    {describeRule(r)}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
      {editing ? <PlanDialog plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

type RuleDraft = { id?: string; trigger: Trigger; pipelineKeys: string[]; rateType: RateType; rate: string; cap: string; clawbackDays: string };
const toDraft = (r: PlanRule): RuleDraft => ({
  id: r.id, // stable rule identity — keeps past accruals bound to this rule across edits (CR-01)
  trigger: r.trigger,
  pipelineKeys: r.pipelineKeys ?? [],
  rateType: r.rateType,
  rate: String(r.rateType === "flat" ? r.rate / 100 : r.rate),
  cap: r.capCents ? String(r.capCents / 100) : "",
  clawbackDays: r.clawbackDays != null ? String(r.clawbackDays) : "",
});
const NEW_RULE: RuleDraft = { trigger: "deal_won", pipelineKeys: [], rateType: "pct_contract", rate: "", cap: "", clawbackDays: "" };

function PlanDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const [name, setName] = React.useState(plan?.name ?? "");
  const [description, setDescription] = React.useState(plan?.description ?? "");
  const [active, setActive] = React.useState(plan?.active ?? true);
  const [rules, setRules] = React.useState<RuleDraft[]>(plan?.rules.map(toDraft) ?? [{ ...NEW_RULE }]);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const upd = (i: number, patch: Partial<RuleDraft>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () =>
    start(async () => {
      const payload = rules.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        pipelineKeys: r.pipelineKeys as (typeof PIPES)[number][],
        rateType: r.rateType,
        rate: r.rateType === "flat" ? Math.round(Number(r.rate || 0) * 100) : Number(r.rate || 0),
        capCents: r.cap ? Math.round(Number(r.cap) * 100) : undefined,
        clawbackDays: r.clawbackDays ? Math.round(Number(r.clawbackDays)) : undefined,
      }));
      const res = await savePlan({ id: plan?.id, name, description: description || null, active, rules: payload });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return void toast.error(res.error);
      }
      toast.success("Plan saved");
      onClose();
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{plan ? "Edit plan" : "New commission plan"}</DialogTitle>
          <DialogDescription>Rules fire on triggers; rates are % of value (0–100) or a flat USD bounty. Caps are per rep per month.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
            <Field label="Plan name" error={errors.name?.[0]}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="flex items-end pb-2">
              <label className="inline-flex items-center gap-2 text-sm text-body">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-white" /> Active
              </label>
            </div>
          </div>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="space-y-3">
            <p className="text-xs font-medium text-secondary">Rules</p>
            {errors.rules?.[0] ? <p className="text-[11px] text-critical">{errors.rules[0]}</p> : null}
            {rules.map((r, i) => (
              <fieldset key={i} className="rounded-md border border-border bg-surface-1 p-3">
                <legend className="sr-only">Rule {i + 1}</legend>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <Field label="Trigger" className="md:col-span-2">
                    <NativeSelect value={r.trigger} onChange={(e) => upd(i, { trigger: e.target.value as Trigger })}>
                      {TRIGGERS.map((t) => (
                        <option key={t} value={t}>
                          {TRIGGER_LABELS[t]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Rate type" className="md:col-span-2">
                    <NativeSelect value={r.rateType} onChange={(e) => upd(i, { rateType: e.target.value as RateType })}>
                      {RATE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {RATE_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label={r.rateType === "flat" ? "Bounty (USD)" : "Rate (%)"}>
                    <Input type="number" min={0} step={r.rateType === "flat" ? 1 : 0.1} max={r.rateType === "flat" ? undefined : 100} value={r.rate} onChange={(e) => upd(i, { rate: e.target.value })} className="tabular" />
                  </Field>
                  <Field label="Monthly cap (USD)" hint="Optional">
                    <Input type="number" min={0} value={r.cap} onChange={(e) => upd(i, { cap: e.target.value })} className="tabular" />
                  </Field>
                  <Field label="Clawback (days)" hint="If the deal is lost within">
                    <Input type="number" min={0} max={730} value={r.clawbackDays} onChange={(e) => upd(i, { clawbackDays: e.target.value })} className="tabular" />
                  </Field>
                  <div className="col-span-2 md:col-span-3">
                    <p className="mb-1 text-xs font-medium text-secondary">Pipelines (none = all)</p>
                    <div className="flex flex-wrap gap-1.5">
                      {PIPES.map((p) => {
                        const on = r.pipelineKeys.includes(p);
                        return (
                          <button
                            key={p}
                            type="button"
                            aria-pressed={on}
                            onClick={() => upd(i, { pipelineKeys: on ? r.pipelineKeys.filter((x) => x !== p) : [...r.pipelineKeys, p] })}
                            className={on ? "rounded border border-white bg-white px-2 py-1 text-xs font-medium text-accent-inverse" : "rounded border border-border-strong px-2 py-1 text-xs text-secondary hover:text-fg"}
                          >
                            {p}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="destructive" disabled={rules.length === 1} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                    <Trash2 /> Remove rule
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button size="sm" onClick={() => setRules([...rules, { ...NEW_RULE }])}>
              <Plus /> Add rule
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending || !name.trim()} onClick={submit}>
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Assignment = { userId: string; userName: string; userRole: string; planId: string; planName: string; effectiveFrom: string };

export function AssignmentsPanel({ assignments, plans, users, canConfigure }: { assignments: Assignment[]; plans: Plan[]; users: { id: string; name: string; role: string }[]; canConfigure: boolean }) {
  const [pending, start] = React.useTransition();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [today] = React.useState(() => new Date().toISOString().slice(0, 10));
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    start(async () => {
      const res = await assignPlan({ userId: String(f.get("userId") ?? ""), planId: String(f.get("planId") ?? ""), effectiveFrom: String(f.get("effectiveFrom") ?? "") });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return void toast.error(res.error);
      }
      setErrors({});
      form.reset();
      toast.success("Plan assigned");
    });
  };
  const remove = (a: Assignment) =>
    start(async () => {
      if (!window.confirm(`Remove ${a.planName} from ${a.userName}? Existing accruals are kept.`)) return;
      const res = await unassignPlan({ userId: a.userId, planId: a.planId });
      if (!res.ok) toast.error(res.error);
      else toast.success("Assignment removed");
    });
  return (
    <div className="space-y-4">
      {canConfigure ? (
        <form onSubmit={submit} className="grid gap-3 rounded-lg border border-border bg-surface-1 p-4 md:grid-cols-[1fr_1fr_180px_auto]">
          <Field label="User" error={errors.userId?.[0]}>
            <NativeSelect name="userId" defaultValue="" required>
              <option value="" disabled>
                Select…
              </option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {ROLE_LABELS[u.role as Role] ?? u.role}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Plan" error={errors.planId?.[0]}>
            <NativeSelect name="planId" defaultValue="" required>
              <option value="" disabled>
                Select…
              </option>
              {plans
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Effective from" error={errors.effectiveFrom?.[0]}>
            <Input type="date" name="effectiveFrom" defaultValue={today} required />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" disabled={pending}>
              Assign
            </Button>
          </div>
        </form>
      ) : null}
      {assignments.length === 0 ? (
        <EmptyState title="No assignments" description="Assign plans to users or roles' members to start accruing." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 font-medium">Effective from</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={`${a.userId}-${a.planId}`} className="border-t border-border">
                  <td className="px-3 py-2 text-fg">{a.userName}</td>
                  <td className="px-3 py-2 text-secondary">{ROLE_LABELS[a.userRole as Role] ?? a.userRole}</td>
                  <td className="px-3 py-2 text-body">{a.planName}</td>
                  <td className="px-3 py-2 tabular">{fmtDate(a.effectiveFrom)}</td>
                  <td className="px-3 py-2 text-right">
                    {canConfigure ? (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${a.planName} from ${a.userName}`} disabled={pending} onClick={() => remove(a)}>
                        <Trash2 />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** COM-7 what-if calculator. */
export function WhatIf({ plans }: { plans: Plan[] }) {
  const [planId, setPlanId] = React.useState(plans[0]?.id ?? "");
  const [pipe, setPipe] = React.useState("ADS");
  const [value, setValue] = React.useState("200000");
  const [split, setSplit] = React.useState("100");
  const plan = plans.find((p) => p.id === planId);
  const dollars = Number(value) || 0;
  const earn = plan ? whatIf(plan.rules, { pipelineKey: pipe, contractCents: Math.round(dollars * 100), netCents: Math.round(dollars * 100), splitPct: Number(split) || 0 }) : 0;
  if (!plans.length) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>What-if</CardTitle>
          <CardDescription>“If this closes at $X, I earn…” (deal won + invoice paid rules).</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Plan" className="lg:col-span-2">
          <NativeSelect value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Pipeline">
          <NativeSelect value={pipe} onChange={(e) => setPipe(e.target.value)}>
            {PIPES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Deal value (USD)">
          <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} className="tabular" />
        </Field>
        <Field label="Your split (%)">
          <Input type="number" min={0} max={100} value={split} onChange={(e) => setSplit(e.target.value)} className="tabular" />
        </Field>
        <p className="sm:col-span-2 lg:col-span-5">
          <span className="text-xs text-muted">Estimated commission </span>
          <span className="font-display text-2xl text-fg tabular">{fmtUsd(earn, { cents: true })}</span>
        </p>
      </CardContent>
    </Card>
  );
}
