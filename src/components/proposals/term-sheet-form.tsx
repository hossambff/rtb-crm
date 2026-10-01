"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/r100/field";
import { DATE_INPUTS, formatDateLike, targetLabel } from "@/lib/proposals/docx/detect";
import type { Tier } from "@/lib/proposals/docx/tiers";
import { termSheetApprovalReasons, termSheetEconomics, type TemplateApproval } from "@/lib/proposals/termsheet";
import { createTermSheet, updateTermSheet } from "@/lib/proposals/term-sheet-actions";
import { PartnerEconomics } from "./partner-economics";

type Props = {
  mode: "create" | "edit";
  dealId: string;
  proposalId?: string;
  targets: string[];
  initial: { values: Record<string, string>; muu: number | null; tierIndex: number | null; notes?: string };
  prefill: Record<string, string>;
  usdPerMuu: number;
  tiers: Tier[];
  approval: TemplateApproval;
  /** Date samples from the template, per target, to preview dates the way the document writes them. */
  dateSamples: Record<string, string | null>;
  onDone?: () => void;
};

const HINTS: Record<string, string> = {
  recipientName: "From the deal's primary contact",
  recipientTitle: "From the primary contact",
  companyLegalName: "Account legal name (or account name)",
  brands: "Brand or publication names",
  region: "From the account's country",
  ccLine: "People copied on the letter",
};

/** Coalition term sheet inputs, prefilled from the deal; live partner economics + approval preview. */
export function TermSheetForm(p: Props) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(p.targets.map((t) => [t, p.initial.values[t] ?? ""])));
  const [muu, setMuu] = React.useState(p.initial.muu === null ? "" : String(p.initial.muu));
  const [tierIndex, setTierIndex] = React.useState<number | null>(p.initial.tierIndex);
  const [notes, setNotes] = React.useState(p.initial.notes ?? "");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();

  const muuNum = muu.trim() === "" ? null : Math.max(0, Math.round(Number(muu.replace(/[, ]/g, ""))));
  const muuValid = muu.trim() === "" || Number.isFinite(muuNum);
  const inputs = { muu: muuValid ? muuNum : null, usdPerMuu: p.usdPerMuu, tierIndex };
  const econ = termSheetEconomics(inputs, p.tiers);
  const reasons = termSheetApprovalReasons({ ...inputs, values, prefill: p.prefill, templateId: "", templateVersion: 0, templateSha256: "", snapshot: { candidates: [], fieldMap: [], tiers: p.tiers, approval: p.approval } }, p.approval, p.tiers);
  const empty = p.targets.filter((t) => !values[t]?.trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!muuValid) return void toast.error("MUU must be a number.");
    start(async () => {
      const payload = { values, muu: inputs.muu, tierIndex, notes: notes.trim() || undefined };
      const res = p.mode === "create" ? await createTermSheet({ ...payload, dealId: p.dealId }) : await updateTermSheet({ ...payload, id: p.proposalId! });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        return void toast.error(res.error);
      }
      setErrors({});
      toast.success(res.data.reasons.length ? "Saved · sent for executive approval" : "Saved");
      if (p.mode === "create") router.push(`/proposals/term-sheets/${res.data.id}`);
      else {
        p.onDone?.();
        router.refresh();
      }
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Letter details</CardTitle>
              <CardDescription>Prefilled from the deal, account and primary contact. Edit anything; blank fields stay as they are in the template.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {p.targets.length === 0 ? <p className="text-sm text-muted sm:col-span-2">The template has no mapped fields. Ask an admin to map them under Admin → Templates.</p> : null}
            {p.targets.map((t) => {
              const isDate = (DATE_INPUTS as string[]).includes(t);
              const changed = (values[t] ?? "") !== (p.prefill[t] ?? "");
              const flagged = p.approval.fields.includes(t as never);
              const hint = isDate && values[t] ? `Reads “${formatDateLike(p.dateSamples[t] ?? null, values[t]!)}”` : changed && p.prefill[t] ? `Deal value: ${p.prefill[t]}` : HINTS[t];
              return (
                <div key={t} className={t === "ccLine" || t.startsWith("custom:") ? "sm:col-span-2" : undefined}>
                  <Field label={`${targetLabel(t)}${flagged ? " · approval if changed" : ""}`} hint={hint}>
                    <Input
                      type={isDate ? "date" : "text"}
                      maxLength={300}
                      value={values[t] ?? ""}
                      onChange={(e) => setValues({ ...values, [t]: e.target.value })}
                      className={changed && flagged ? "border-warning" : undefined}
                    />
                  </Field>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Audience &amp; tier</CardTitle>
              <CardDescription>The tier comes from the revenue-share schedule in the template, matched on monthly users.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Monthly unique users (MUU)" hint="From the deal (or account)" error={!muuValid ? "Enter a whole number" : errors.muu?.[0]}>
              <Input inputMode="numeric" value={muu} onChange={(e) => setMuu(e.target.value)} placeholder="e.g. 2500000" className="tabular" />
            </Field>
            <Field label={`Tier${p.approval.tierChange ? " · approval if changed" : ""}`} hint={econ.impliedTierIndex !== null ? `MUU tier: ${p.tiers[econ.impliedTierIndex]?.label}` : "No tier matches the MUU"}>
              <NativeSelect value={tierIndex === null ? "" : String(tierIndex)} onChange={(e) => setTierIndex(e.target.value === "" ? null : Number(e.target.value))} disabled={!p.tiers.length}>
                <option value="">Automatic (from MUU)</option>
                {p.tiers.map((t, i) => (
                  <option key={i} value={i}>
                    {t.label} · partner {t.partnerPct}%
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Internal notes (not in the document)">
                <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <PartnerEconomics e={econ} tiers={p.tiers} />
        {reasons.length ? (
          <div className="rounded-lg border border-border p-3 text-sm">
            <StatusBadge status="warning" label="Needs executive approval" />
            <ul className="mt-2 space-y-1 text-xs text-secondary">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {empty.length ? <p className="text-xs text-muted">{empty.length} field{empty.length === 1 ? "" : "s"} blank: the template text stays there.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending} className="flex-1">
            <Save /> {p.mode === "create" ? "Create term sheet" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setValues(Object.fromEntries(p.targets.map((t) => [t, p.prefill[t] ?? ""])));
              setTierIndex(null);
            }}
          >
            <RotateCcw /> Reset to deal
          </Button>
        </div>
      </aside>
    </form>
  );
}
