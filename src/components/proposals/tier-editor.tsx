"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftRight, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { bandText, parseAmount, validateTiers, type Tier, type TierTable } from "@/lib/proposals/docx/tiers";
import { saveTemplateTiers } from "@/lib/proposals/template-actions";

type Row = { label: string; min: string; max: string; minExclusive?: boolean; maxExclusive?: boolean; partnerPct: string; rtbPct: string };

const fmtAmt = (v: number | null) => (v === null ? "" : v >= 1e6 && v % 1e5 === 0 ? `${v / 1e6}M` : v >= 1e3 && v % 100 === 0 ? `${v / 1e3}K` : String(v));
const toRow = (t: Tier): Row => ({ label: t.label, min: fmtAmt(t.min), max: fmtAmt(t.max), minExclusive: t.minExclusive, maxExclusive: t.maxExclusive, partnerPct: String(t.partnerPct), rtbPct: String(t.rtbPct) });
const toTier = (r: Row): Tier => ({
  label: r.label.trim(),
  min: r.min.trim() ? parseAmount(r.min) : null,
  max: r.max.trim() ? parseAmount(r.max) : null,
  ...(r.minExclusive ? { minExclusive: true } : {}),
  ...(r.maxExclusive ? { maxExclusive: true } : {}),
  partnerPct: Number(r.partnerPct),
  rtbPct: Number(r.rtbPct),
});

/** Admin review of the revenue-share schedule parsed from the uploaded document. */
export function TierEditor(p: { templateId: string; tables: TierTable[]; tiers: Tier[]; tableIndex: number | null; reviewed: boolean; readOnly?: boolean }) {
  const router = useRouter();
  const [tableIndex, setTableIndex] = React.useState<number | null>(p.tableIndex);
  const [rows, setRows] = React.useState<Row[]>(p.tiers.map(toRow));
  const [pending, start] = React.useTransition();
  const tiers = rows.map(toTier);
  const parseErrors = rows.flatMap((r, i) => [
    ...(r.min.trim() && parseAmount(r.min) === null ? [`Row ${i + 1}: can't read "${r.min}" (use e.g. 500K, 20M).`] : []),
    ...(r.max.trim() && parseAmount(r.max) === null ? [`Row ${i + 1}: can't read "${r.max}".`] : []),
  ]);
  const errors = [...parseErrors, ...validateTiers(tiers)];
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const table = tableIndex !== null ? p.tables.find((t) => t.index === tableIndex) : undefined;

  const save = () =>
    start(async () => {
      if (errors.length) return void toast.error(errors[0]!);
      const res = await saveTemplateTiers({ id: p.templateId, tierTableIndex: tableIndex, tiers });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Tiers saved and marked reviewed");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {p.reviewed ? <StatusBadge status="good" label="Reviewed" /> : <StatusBadge status="warning" label="Needs review" />}
        {p.tables.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-secondary">
            Source table
            <NativeSelect
              aria-label="Source table"
              className="h-8 w-auto text-xs"
              disabled={p.readOnly || pending}
              value={tableIndex === null ? "" : String(tableIndex)}
              onChange={(e) => {
                const idx = e.target.value === "" ? null : Number(e.target.value);
                setTableIndex(idx);
                const t = p.tables.find((x) => x.index === idx);
                if (t) setRows(t.tiers.map(toRow));
              }}
            >
              <option value="">Entered manually</option>
              {p.tables.map((t) => (
                <option key={t.index} value={t.index}>
                  Table {t.index + 1}
                  {t.title ? ` · ${t.title.slice(0, 50)}` : ""}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <span className="text-xs text-muted">No tier table was detected in the document. Enter the schedule manually if it has one.</span>
        )}
        {table?.columnsGuessed ? <span className="text-xs text-muted">Column headers didn&apos;t say which share is whose: check partner vs Roundtable.</span> : null}
      </div>

      {table && table.headers.length ? (
        <p className="text-xs text-muted">
          Document headers: <span className="text-secondary">{table.headers.filter(Boolean).join(" · ")}</span>
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-1 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Band (as written)</th>
              <th className="px-3 py-2 font-medium">From (MUU)</th>
              <th className="px-3 py-2 font-medium">To (MUU)</th>
              <th className="px-3 py-2 text-right font-medium">Partner %</th>
              <th className="px-3 py-2 text-right font-medium">Roundtable %</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-3 py-1.5">
                  <Input aria-label={`Row ${i + 1} label`} className="h-8" value={r.label} disabled={p.readOnly} onChange={(e) => set(i, { label: e.target.value })} />
                </td>
                <td className="px-3 py-1.5">
                  <Input aria-label={`Row ${i + 1} from`} className="h-8 tabular" placeholder="none" value={r.min} disabled={p.readOnly} onChange={(e) => set(i, { min: e.target.value, minExclusive: false })} />
                </td>
                <td className="px-3 py-1.5">
                  <Input aria-label={`Row ${i + 1} to`} className="h-8 tabular" placeholder="none" value={r.max} disabled={p.readOnly} onChange={(e) => set(i, { max: e.target.value, maxExclusive: false })} />
                </td>
                <td className="px-3 py-1.5">
                  <Input aria-label={`Row ${i + 1} partner percent`} type="number" min={0} max={100} step="any" className="h-8 text-right tabular" value={r.partnerPct} disabled={p.readOnly} onChange={(e) => set(i, { partnerPct: e.target.value })} />
                </td>
                <td className="px-3 py-1.5">
                  <Input aria-label={`Row ${i + 1} Roundtable percent`} type="number" min={0} max={100} step="any" className="h-8 text-right tabular" value={r.rtbPct} disabled={p.readOnly} onChange={(e) => set(i, { rtbPct: e.target.value })} />
                </td>
                <td className="px-2 py-1.5">
                  {!p.readOnly ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-muted">
                  No tiers. Term sheets will show no applicable tier.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Read as: {tiers.filter((t) => t.min !== null || t.max !== null).map((t) => bandText(t)).join(" · ") || "—"}. A deal&apos;s MUU picks the band it falls in; where bands touch, the higher band wins.
      </p>
      {errors.length ? (
        <ul role="alert" className="space-y-0.5 text-xs text-critical">
          {errors.slice(0, 4).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {!p.readOnly ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setRows([...rows, { label: "", min: "", max: "", partnerPct: "", rtbPct: "" }])}>
              <Plus /> Add tier
            </Button>
            <Button size="sm" variant="ghost" disabled={!rows.length} onClick={() => setRows(rows.map((r) => ({ ...r, partnerPct: r.rtbPct, rtbPct: r.partnerPct })))}>
              <ArrowLeftRight /> Swap partner / Roundtable
            </Button>
          </div>
          <Button variant="primary" onClick={save} disabled={pending || errors.length > 0}>
            <CheckCircle2 /> Save &amp; mark reviewed
          </Button>
        </div>
      ) : null}
    </div>
  );
}
