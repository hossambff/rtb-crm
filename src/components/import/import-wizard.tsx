"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, Save, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { IMPORT_TARGETS, applyTemplate, fieldsFor, type ImportTarget, type Mapping } from "@/lib/import/fields";
import { saveImportTemplate } from "@/lib/import/actions";
import { fmtNumber } from "@/lib/format";
import { STATUS_COLORS } from "@/lib/palette";
import { cn } from "@/lib/utils";

type SheetInfo = { name: string; headerRow: number; rowCount: number; headers: string[]; sample: string[][]; suggested: Record<ImportTarget, Mapping> };
type Template = { id: string; name: string; target: ImportTarget; pipelineKey: string | null; mapping: Mapping };
type Stats = Record<string, number>;
type PreviewRow = {
  rowNumber: number;
  cells: { column: string; field: string; value: string }[];
  outcome: { account: string; deal: string; stageKey: string | null; owners: string[]; contacts: number } | null;
  account: { name: string; domain: string | null } | null;
  deal: { stageKey: string | null; owners: string[]; muu: number | null; statusRaw: string | null } | null;
  audience: { metric: string; value: number; rawValue: string; derivedMuu?: number | null }[];
  contacts: { fullName: string; email: string | null; title: string | null }[];
  notes: number;
  issues: { level: "error" | "warning"; field: string; message: string }[];
};
type Preview = { totalRows: number; skipped: number; stats: Stats; unmapped: Record<string, number>; rows: PreviewRow[]; stages: { key: string; name: string }[] };

const STEPS = ["Upload", "Sheet & target", "Map columns", "Preview", "Import"] as const;

async function postForm<T>(url: string, fd: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({ error: "Unexpected response" }))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export function ImportWizard({ pipelines, canSaveTemplates }: { pipelines: { key: string; name: string }[]; canSaveTemplates: boolean }) {
  const router = useRouter();
  const [step, setStep] = React.useState(0);
  const [file, setFile] = React.useState<File | null>(null);
  const [sheets, setSheets] = React.useState<SheetInfo[]>([]);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [sheetName, setSheetName] = React.useState("");
  const [target, setTarget] = React.useState<ImportTarget>("accounts_deals");
  const [pipelineKey, setPipelineKey] = React.useState(pipelines.find((p) => p.key === "NET")?.key ?? pipelines[0]?.key ?? "NET");
  const [mapping, setMapping] = React.useState<Mapping>({});
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [result, setResult] = React.useState<{ batchId: string; stats: Stats } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [tplName, setTplName] = React.useState("");
  const [dragging, setDragging] = React.useState(false);
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];

  const upload = async (f: File, override?: { sheet: string; headerRow: number }) => {
    setBusy("Reading file…");
    try {
      const fd = new FormData();
      fd.set("file", f);
      if (override) {
        fd.set("sheet", override.sheet);
        fd.set("headerRow", String(override.headerRow));
      }
      const res = await postForm<{ fileName: string; sheets: SheetInfo[]; templates: Template[] }>("/api/import/parse", fd);
      setFile(f);
      setSheets(res.sheets);
      setTemplates(res.templates);
      const chosen = override?.sheet ?? res.sheets.slice().sort((a, b) => b.rowCount - a.rowCount)[0]?.name ?? "";
      setSheetName(chosen);
      const sh = res.sheets.find((s) => s.name === chosen);
      if (sh) setMapping(sh.suggested[target]);
      setPreview(null);
      if (!override) setStep(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const requestForm = () => {
    const fd = new FormData();
    fd.set("file", file!);
    fd.set("sheet", sheet!.name);
    fd.set("headerRow", String(sheet!.headerRow));
    fd.set("target", target);
    if (target === "accounts_deals") fd.set("pipelineKey", pipelineKey);
    fd.set("mapping", JSON.stringify(mapping));
    return fd;
  };

  const runPreview = async () => {
    setBusy("Validating every row against the CRM…");
    try {
      setPreview(await postForm<Preview>("/api/import/preview", requestForm()));
      setStep(3);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    setBusy("Importing…");
    try {
      const res = await postForm<{ batchId: string; stats: Stats }>("/api/import/commit", requestForm());
      setResult(res);
      setStep(4);
      toast.success("Import complete");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const hasIdentity = Object.values(mapping).some((v) => v === "account.name" || v === "account.domain");
  const tplForTarget = templates.filter((t) => t.target === target);

  return (
    <div>
      <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs" aria-label="Import steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                i === step ? "border-white text-fg" : i < step ? "border-border-strong text-secondary" : "border-border text-muted",
              )}
            >
              <span className="tabular">{i + 1}</span> {label}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px w-4 bg-border" aria-hidden /> : null}
          </li>
        ))}
      </ol>

      {busy ? (
        <p className="mb-4 flex items-center gap-2 text-sm text-secondary" role="status">
          <Loader2 className="size-4 animate-spin" /> {busy}
        </p>
      ) : null}

      {step === 0 ? (
        <Card>
          <CardContent className="p-6">
            <label
              htmlFor="import-file"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) void upload(f);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center transition-colors duration-150",
                dragging ? "border-white bg-surface-2" : "border-border-strong hover:bg-surface-2",
              )}
            >
              <Upload className="mb-3 size-6 text-secondary" aria-hidden />
              <span className="font-display text-lg text-fg">Drop a spreadsheet here</span>
              <span className="mt-1 text-sm text-muted">CSV or Excel (.xlsx, multi-sheet) · up to 10 MB, 20,000 rows</span>
              <input
                id="import-file"
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
            </label>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 && sheet ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardContent className="space-y-4 p-5">
              <p className="flex items-center gap-2 text-sm text-fg">
                <FileSpreadsheet className="size-4 text-secondary" aria-hidden /> <span className="truncate">{file?.name}</span>
              </p>
              <fieldset>
                <legend className="mb-2 text-xs font-medium text-secondary">Sheet</legend>
                <div className="space-y-1">
                  {sheets.map((s) => (
                    <label key={s.name} className={cn("flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm", s.name === sheet.name ? "border-border-strong bg-surface-2 text-fg" : "border-border text-secondary")}>
                      <span className="flex items-center gap-2 truncate">
                        <input
                          type="radio"
                          name="sheet"
                          className="accent-white"
                          checked={s.name === sheet.name}
                          onChange={() => {
                            setSheetName(s.name);
                            setMapping(s.suggested[target]);
                          }}
                        />
                        <span className="truncate">{s.name}</span>
                      </span>
                      <span className="tabular text-xs text-muted">{fmtNumber(s.rowCount)} rows</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="hdr">Header row</Label>
                <Input
                  id="hdr"
                  type="number"
                  min={1}
                  max={50}
                  value={sheet.headerRow + 1}
                  onChange={(e) => {
                    const n = Number(e.target.value) - 1;
                    if (file && n >= 0 && n < 50) void upload(file, { sheet: sheet.name, headerRow: n });
                  }}
                />
                <p className="text-xs text-muted">Auto-detected. Change it if the sheet has title rows above the headers.</p>
              </div>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardContent className="space-y-4 p-5">
              <fieldset>
                <legend className="mb-2 text-xs font-medium text-secondary">What are you importing?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {IMPORT_TARGETS.map((t) => (
                    <label key={t.key} className={cn("cursor-pointer rounded-md border p-3", target === t.key ? "border-white bg-surface-2" : "border-border hover:bg-surface-2")}>
                      <span className="flex items-center gap-2 text-sm font-medium text-fg">
                        <input
                          type="radio"
                          name="target"
                          className="accent-white"
                          checked={target === t.key}
                          onChange={() => {
                            setTarget(t.key);
                            setMapping(sheet.suggested[t.key]);
                          }}
                        />
                        {t.label}
                      </span>
                      <span className="mt-1 block text-xs text-muted">{t.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {target === "accounts_deals" ? (
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="pipe">Pipeline</Label>
                  <NativeSelect id="pipe" value={pipelineKey} onChange={(e) => setPipelineKey(e.target.value)}>
                    {pipelines
                      .filter((p) => !["R100", "ADS"].includes(p.key))
                      .map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.key} — {p.name}
                        </option>
                      ))}
                  </NativeSelect>
                </div>
              ) : null}
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      {sheet.headers.map((h) => (
                        <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.sample.map((r, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        {r.map((v, j) => (
                          <td key={j} className="max-w-[180px] truncate whitespace-nowrap px-2 py-1.5 text-secondary">
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setStep(0)}>
                  <ArrowLeft /> Back
                </Button>
                <Button variant="primary" onClick={() => setStep(2)} disabled={!sheet.rowCount}>
                  Map columns <ArrowRight />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 2 && sheet ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm text-fg">
                  {mappedCount} of {sheet.headers.length} columns mapped
                </p>
                <p className="text-xs text-muted">Suggestions come from header similarity. Statuses map to stages through each stage&apos;s import aliases; MUU strings like “1.5–2M” keep their raw value.</p>
              </div>
              {tplForTarget.length ? (
                <div className="w-60 space-y-1.5">
                  <Label htmlFor="tpl">Apply saved mapping</Label>
                  <NativeSelect
                    id="tpl"
                    defaultValue=""
                    onChange={(e) => {
                      const t = tplForTarget.find((x) => x.id === e.target.value);
                      if (t) {
                        setMapping(applyTemplate(sheet.headers, t.mapping, target));
                        if (t.pipelineKey && target === "accounts_deals") setPipelineKey(t.pipelineKey);
                        toast.success(`Applied “${t.name}”`);
                      }
                    }}
                  >
                    <option value="">Choose template…</option>
                    {tplForTarget.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="h-9 px-3 font-medium">Column</th>
                    <th className="px-3 font-medium">Sample</th>
                    <th className="w-72 px-3 font-medium">Maps to</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.headers.map((h, i) => (
                    <tr key={h} className="border-b border-border last:border-0">
                      <td className="h-10 whitespace-nowrap px-3 text-fg">{h}</td>
                      <td className="max-w-[320px] truncate px-3 text-xs text-muted">{sheet.sample.map((r) => r[i]).filter(Boolean).slice(0, 3).join(" · ") || "—"}</td>
                      <td className="px-3 py-1">
                        <NativeSelect
                          aria-label={`Field for ${h}`}
                          value={mapping[h] ?? ""}
                          onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                          className={cn("h-8 text-xs", mapping[h] ? "text-fg" : "text-muted")}
                        >
                          <option value="">— Ignore —</option>
                          {(["Account", "Audience", "Deal", "Contact", "R100", "ADS"] as const).map((g) => {
                            const opts = fieldsFor(target).filter((f) => f.group === g);
                            return opts.length ? (
                              <optgroup key={g} label={g}>
                                {opts.map((f) => (
                                  <option key={f.key} value={f.key}>
                                    {f.label}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null;
                          })}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!hasIdentity ? (
              <p className="flex items-center gap-1.5 text-xs text-secondary" role="alert">
                <AlertTriangle className="size-3.5" style={{ color: STATUS_COLORS.warning }} aria-hidden /> Map an account name or domain column — rows are matched to accounts by domain, then name.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft /> Back
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {canSaveTemplates ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const res = await saveImportTemplate({ name: tplName, target, pipelineKey: target === "accounts_deals" ? pipelineKey : null, mapping });
                      if (!res.ok) return toast.error(res.error);
                      setTemplates((ts) => [...ts.filter((t) => t.id !== res.data.id), res.data]);
                      setTplName("");
                      toast.success("Mapping saved as template");
                    }}
                  >
                    <Input aria-label="Template name" placeholder="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} className="h-8 w-44 text-xs" />
                    <Button type="submit" size="sm" variant="secondary" disabled={!tplName.trim()}>
                      <Save /> Save mapping
                    </Button>
                  </form>
                ) : null}
                <Button variant="primary" onClick={runPreview} disabled={!hasIdentity || !!busy}>
                  Preview import <ArrowRight />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 && preview ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <MiniStat label="Rows" value={preview.totalRows} />
            <MiniStat label="Accounts new" value={preview.stats.accountsCreated ?? 0} />
            <MiniStat label="Accounts updated" value={preview.stats.accountsUpdated ?? 0} hint="empty fields filled" />
            <MiniStat label="Deals new" value={preview.stats.dealsCreated ?? 0} />
            <MiniStat label="Deals updated" value={preview.stats.dealsUpdated ?? 0} hint="most advanced stage kept" />
            <MiniStat label="Contacts new" value={preview.stats.contactsCreated ?? 0} />
            <MiniStat label="Merged in file" value={preview.stats.duplicatesMerged ?? 0} hint="duplicate rows" />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {preview.skipped ? <StatusBadge status="critical" label={`${preview.skipped} rows skipped (no name/domain)`} /> : null}
            {preview.stats.warnings ? <StatusBadge status="warning" label={`${preview.stats.warnings} warnings`} /> : null}
            {preview.stats.placeholdersCreated ? <StatusBadge status="warning" label={`${preview.stats.placeholdersCreated} unknown reps → placeholder users`} /> : null}
            {Object.keys(preview.unmapped).length ? (
              <StatusBadge status="serious" label={`Unmapped statuses: ${Object.entries(preview.unmapped).map(([k, v]) => `${k} (${v})`).join(", ")}`} />
            ) : null}
            {!preview.skipped && !preview.stats.warnings && !Object.keys(preview.unmapped).length ? <StatusBadge status="good" label="No validation issues" /> : null}
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="h-9 px-3 font-medium">Row</th>
                    <th className="px-3 font-medium">Account</th>
                    <th className="px-3 font-medium">Result</th>
                    <th className="px-3 font-medium">Stage</th>
                    <th className="px-3 font-medium">Owners</th>
                    <th className="px-3 font-medium">Audience</th>
                    <th className="px-3 font-medium">Contacts</th>
                    <th className="px-3 font-medium">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.rowNumber} className="border-b border-border align-top last:border-0">
                      <td className="px-3 py-2 tabular text-muted">{r.rowNumber}</td>
                      <td className="px-3 py-2">
                        <span className="text-fg">{r.account?.name ?? "—"}</span>
                        {r.account?.domain ? <span className="block text-xs text-muted">{r.account.domain}</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        {r.outcome ? (
                          <span className="flex flex-wrap gap-1">
                            <Badge>account {r.outcome.account}</Badge>
                            {r.outcome.deal !== "none" ? <Badge>deal {r.outcome.deal}</Badge> : null}
                          </span>
                        ) : (
                          <StatusBadge status="critical" label="skipped" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-secondary">
                        {r.deal ? preview.stages.find((s) => s.key === r.deal!.stageKey)?.name ?? r.deal.stageKey ?? "—" : "—"}
                        {r.deal?.statusRaw ? <span className="block text-[11px] text-muted">“{r.deal.statusRaw}”</span> : null}
                      </td>
                      <td className="px-3 py-2 text-secondary">{r.deal?.owners.length ? r.deal.owners.join(" / ") : "—"}</td>
                      <td className="px-3 py-2 text-xs text-secondary">
                        {r.audience.length
                          ? r.audience.map((a) => (
                              <span key={a.metric} className="block">
                                {a.metric === "muu" ? "MUU" : "Visits"} {fmtNumber(a.value, { compact: true })} <span className="text-muted">(“{a.rawValue}”)</span>
                                {a.derivedMuu ? <span className="block italic text-muted">≈ {fmtNumber(a.derivedMuu, { compact: true })} MUU est.</span> : null}
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-secondary">
                        {r.contacts.length ? r.contacts.map((c) => <span key={`${c.fullName}${c.email}`} className="block truncate">{c.fullName}{c.email ? ` <${c.email}>` : ""}</span>) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.issues.length ? (
                          r.issues.map((i, k) => (
                            <span key={k} className="flex items-start gap-1 text-secondary">
                              {i.level === "error" ? <XCircle className="mt-0.5 size-3 shrink-0" style={{ color: STATUS_COLORS.critical }} aria-label="Error" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" style={{ color: STATUS_COLORS.warning }} aria-label="Warning" />}
                              {i.message}
                            </span>
                          ))
                        ) : (
                          <CheckCircle2 className="size-3.5" style={{ color: STATUS_COLORS.good }} aria-label="OK" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted">
            Showing the first {preview.rows.length} of {fmtNumber(preview.totalRows)} rows. Merge policy: one account per domain (else name), one open deal per account per pipeline, keep the most advanced stage, only fill empty fields. Every
            imported deal gets a next step due in 7 days and the “imported” tag.
          </p>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              <ArrowLeft /> Back to mapping
            </Button>
            <Button variant="primary" onClick={commit} disabled={!!busy}>
              Import {fmtNumber(preview.totalRows - preview.skipped)} rows
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 && result ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            <p className="flex items-center gap-2 font-display text-xl text-fg">
              <CheckCircle2 className="size-5" style={{ color: STATUS_COLORS.good }} aria-hidden /> Import complete
            </p>
            <p className="text-sm text-secondary">
              {result.stats.accountsCreated ?? 0} accounts created, {result.stats.accountsUpdated ?? 0} updated · {result.stats.dealsCreated ?? 0} deals created, {result.stats.dealsUpdated ?? 0} updated · {result.stats.contactsCreated ?? 0} contacts ·{" "}
              {result.stats.activitiesCreated ?? 0} notes. Every change is recorded and can be rolled back in one click.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="primary">
                <Link href={`/import/history/${result.batchId}`}>View batch</Link>
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setStep(0);
                  setFile(null);
                  setSheets([]);
                  setPreview(null);
                  setResult(null);
                }}
              >
                Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl text-fg tabular">{fmtNumber(value)}</p>
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

