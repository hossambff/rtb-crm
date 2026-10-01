"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileUp, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { normalizeDomain, parseAudience } from "@/lib/domain";
import { fmtNumber } from "@/lib/format";
import { parseNaturalLanguage, previewSearchRun, runSearch, saveSearch } from "@/lib/scout/actions";
import { OWNERSHIP_LABELS, OWNERSHIP_OPTIONS, SCOUT_CATEGORIES, type Criteria } from "@/lib/scout/criteria";
import { parseDomainText, type DomainRow } from "@/lib/scout/domain-list";
import { CostEstimate, type BudgetView, type EstimateLine } from "./budget-notice";
import { TagInput } from "./tag-input";

type Initial = { id?: string; name: string; schedule: "once" | "weekly"; criteria: Partial<Criteria> };

const COUNTRIES = ["US", "GB", "IE", "CA", "AU", "ES", "MX", "AR", "CO", "IN", "PL", "DE", "FR"];

export function SearchBuilder({ initial, apifyConnected, maxDomainsPerRun }: { initial?: Initial; apifyConnected: boolean; maxDomainsPerRun: number }) {
  const router = useRouter();
  const c0 = initial?.criteria ?? {};
  const [name, setName] = React.useState(initial?.name ?? "");
  const [schedule, setSchedule] = React.useState<"once" | "weekly">(initial?.schedule ?? "once");
  const [categories, setCategories] = React.useState<string[]>(c0.categories ?? []);
  const [countries, setCountries] = React.useState<string[]>(c0.countries ?? []);
  const [languages, setLanguages] = React.useState<string[]>(c0.languages ?? []);
  const [muuMin, setMuuMin] = React.useState(c0.muuMin != null ? String(c0.muuMin) : "");
  const [muuMax, setMuuMax] = React.useState(c0.muuMax != null ? String(c0.muuMax) : "");
  const [ownership, setOwnership] = React.useState<string[]>(c0.ownership ?? []);
  const [keywords, setKeywords] = React.useState<string[]>(c0.keywords ?? []);
  const [seedDomains, setSeedDomains] = React.useState<string[]>(c0.seedDomains ?? []);
  const [excludeDomains, setExcludeDomains] = React.useState<string[]>(c0.excludeDomains ?? []);
  const [includeTechStack, setIncludeTechStack] = React.useState(Boolean(c0.includeTechStack));
  const [notInPipeline, setNotInPipeline] = React.useState(Boolean(c0.notInPipeline));
  const [list, setList] = React.useState<DomainRow[]>((c0.domains ?? []).map((d) => ({ domain: d, muu: c0.manualMuu?.[d] ?? null })));
  const [paste, setPaste] = React.useState("");
  const [nl, setNl] = React.useState("");
  const [nlResult, setNlResult] = React.useState<{ summary: string; engine: string } | null>(null);
  const [estimate, setEstimate] = React.useState<{ lines: EstimateLine[]; budget: BudgetView; domainsExpected: number; cappedDomains: number } | null>(null);
  const [busy, setBusy] = React.useState<null | "nl" | "estimate" | "save" | "run" | "upload">(null);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const fileRef = React.useRef<HTMLInputElement>(null);

  const criteria = (): Criteria => ({
    categories,
    countries,
    languages,
    muuMin: muuMin.trim() ? parseAudience(muuMin) : null,
    muuMax: muuMax.trim() ? parseAudience(muuMax) : null,
    ownership: ownership as Criteria["ownership"],
    keywords,
    seedDomains,
    domains: list.map((r) => r.domain),
    excludeDomains,
    manualMuu: Object.fromEntries(list.filter((r) => r.muu != null).map((r) => [r.domain, r.muu!])),
    includeTechStack,
    notInPipeline,
  });

  const mergeRows = (rows: DomainRow[]) => {
    setList((prev) => {
      const map = new Map(prev.map((r) => [r.domain, r]));
      for (const r of rows) map.set(r.domain, { domain: r.domain, muu: r.muu ?? map.get(r.domain)?.muu ?? null });
      return [...map.values()].slice(0, 2000);
    });
    setEstimate(null);
  };

  async function onFile(f: File) {
    setBusy("upload");
    try {
      if (/\.(csv|txt)$/i.test(f.name)) {
        const res = parseDomainText(await f.text());
        mergeRows(res.rows);
        toast.success(`${res.rows.length} domains added${res.invalid.length ? `, ${res.invalid.length} invalid skipped` : ""}`);
      } else {
        const fd = new FormData();
        fd.set("file", f);
        const r = await fetch("/api/scout/parse-domains", { method: "POST", body: fd });
        const j = (await r.json()) as { rows?: DomainRow[]; invalid?: string[]; error?: string };
        if (!r.ok || !j.rows) throw new Error(j.error ?? "Upload failed");
        mergeRows(j.rows);
        toast.success(`${j.rows.length} domains added${j.invalid?.length ? `, ${j.invalid.length} invalid skipped` : ""}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function translate() {
    setBusy("nl");
    const r = await parseNaturalLanguage({ text: nl });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    const c = r.data.criteria;
    setCategories(c.categories);
    setCountries(c.countries);
    setLanguages(c.languages);
    setMuuMin(c.muuMin != null ? String(c.muuMin) : "");
    setMuuMax(c.muuMax != null ? String(c.muuMax) : "");
    setOwnership(c.ownership);
    setKeywords(c.keywords);
    if (c.seedDomains.length) setSeedDomains(c.seedDomains);
    setNotInPipeline(c.notInPipeline);
    if (!name) setName(nl.slice(0, 80));
    setNlResult({ summary: r.data.summary, engine: r.data.engine });
    setEstimate(null);
  }

  async function doEstimate() {
    setBusy("estimate");
    const r = await previewSearchRun({ searchId: undefined, criteria: criteria() });
    setBusy(null);
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return void toast.error(r.error);
    }
    setEstimate({ lines: r.data.estimate.lines, budget: r.data.budget, domainsExpected: r.data.estimate.domainsExpected, cappedDomains: r.data.estimate.cappedDomains });
  }

  async function save(andRun: boolean) {
    setBusy(andRun ? "run" : "save");
    setErrors({});
    const r = await saveSearch({ id: initial?.id, name, criteria: criteria(), schedule });
    if (!r.ok) {
      setBusy(null);
      setErrors(r.fieldErrors ?? {});
      return void toast.error(r.error);
    }
    if (r.data.suppressed.length) toast.message(`${r.data.suppressed.length} suppressed domain(s) removed`);
    if (!andRun) {
      setBusy(null);
      toast.success("Search saved");
      router.push("/scout?tab=searches");
      return;
    }
    const run = await runSearch({ searchId: r.data.id });
    setBusy(null);
    if (!run.ok) return void toast.error(run.error);
    if (run.data.blocked) {
      toast.error(run.data.message);
      router.push("/scout?tab=searches");
      return;
    }
    toast.success("Search running — candidates appear in the review queue");
    router.push(run.data.runId ? `/scout/runs/${run.data.runId}` : "/scout?tab=queue");
  }

  const needsApify = seedDomains.length > 0 || keywords.length > 0 || (categories.length > 0 && list.length === 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Describe it</CardTitle>
              <CardDescription>e.g. “Find 50 independent UK and Irish finance or politics publishers with 1–10M monthly users that aren’t in our pipeline.”</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="nl" className="sr-only">
              Natural-language search
            </Label>
            <Textarea id="nl" value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Describe the publishers you want to find…" maxLength={1000} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" disabled={nl.trim().length < 5 || busy !== null} onClick={translate}>
                <Sparkles aria-hidden /> {busy === "nl" ? "Translating…" : "Turn into filters"}
              </Button>
              {nlResult ? (
                <p className="text-xs text-secondary">
                  Interpreted as: <span className="text-body">{nlResult.summary}</span>{" "}
                  <span className="text-muted">({nlResult.engine === "heuristic" ? "rule-based" : nlResult.engine}) — check the filters below before running.</span>
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Search name" htmlFor="name" error={errors.name}>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="UK finance independents" maxLength={120} />
            </Field>
            <Field label="Schedule" htmlFor="schedule">
              <NativeSelect id="schedule" value={schedule} onChange={(e) => setSchedule(e.target.value as "once" | "weekly")}>
                <option value="once">Run once</option>
                <option value="weekly">Weekly — new candidates only</option>
              </NativeSelect>
            </Field>
            <Field label="Verticals" htmlFor="categories">
              <TagInput id="categories" value={categories} onChange={setCategories} suggestions={SCOUT_CATEGORIES} placeholder="Finance, Crypto…" aria-label="Verticals" />
            </Field>
            <Field label="Countries (ISO)" htmlFor="countries">
              <TagInput id="countries" value={countries} onChange={setCountries} suggestions={COUNTRIES} transform={(s) => (/^[a-z]{2}$/i.test(s) ? (s.toUpperCase() === "UK" ? "GB" : s.toUpperCase()) : null)} placeholder="US, GB…" aria-label="Countries" />
            </Field>
            <Field label="Languages" htmlFor="languages">
              <TagInput id="languages" value={languages} onChange={setLanguages} transform={(s) => (/^[a-z]{2}$/i.test(s) ? s.toLowerCase() : null)} placeholder="en, es…" aria-label="Languages" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="MUU min" htmlFor="muuMin" error={errors.muuMin}>
                <Input id="muuMin" inputMode="decimal" value={muuMin} onChange={(e) => setMuuMin(e.target.value)} placeholder="250k" />
              </Field>
              <Field label="MUU max" htmlFor="muuMax" error={errors.muuMax}>
                <Input id="muuMax" inputMode="decimal" value={muuMax} onChange={(e) => setMuuMax(e.target.value)} placeholder="25M" />
              </Field>
            </div>
            <fieldset className="space-y-1.5 md:col-span-2">
              <legend className="text-xs font-medium text-secondary">Ownership</legend>
              <div className="flex flex-wrap gap-4">
                {OWNERSHIP_OPTIONS.map((o) => (
                  <label key={o} className="flex items-center gap-2 text-sm text-body">
                    <input type="checkbox" className="accent-white" checked={ownership.includes(o)} onChange={(e) => setOwnership(e.target.checked ? [...ownership, o] : ownership.filter((x) => x !== o))} />
                    {OWNERSHIP_LABELS[o]}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Keywords (Google discovery)" htmlFor="keywords">
              <TagInput id="keywords" value={keywords} onChange={setKeywords} placeholder="independent crypto news site" aria-label="Keywords" />
            </Field>
            <Field label="Lookalikes of (seed domains)" htmlFor="seeds">
              <TagInput id="seeds" value={seedDomains} onChange={setSeedDomains} transform={normalizeDomain} placeholder="thedefensepost.com" aria-label="Seed domains" />
            </Field>
            <Field label="Exclude domains" htmlFor="exclude">
              <TagInput id="exclude" value={excludeDomains} onChange={setExcludeDomains} transform={normalizeDomain} placeholder="competitor.com" aria-label="Exclude domains" />
            </Field>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-white" checked={notInPipeline} onChange={(e) => setNotInPipeline(e.target.checked)} />
                Skip domains with an open deal
              </label>
              <label className={`flex items-center gap-2 ${apifyConnected ? "" : "opacity-50"}`}>
                <input type="checkbox" className="accent-white" disabled={!apifyConnected} checked={includeTechStack} onChange={(e) => setIncludeTechStack(e.target.checked)} />
                Detect tech stack (extra cost)
              </label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Domain list</CardTitle>
              <CardDescription>Works without Apify: domains are scored with CRM data and any MUU you enter; otherwise MUU is marked unknown.</CardDescription>
            </div>
            <div className="flex gap-2">
              <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx" className="sr-only" id="domain-file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                <FileUp aria-hidden /> {busy === "upload" ? "Reading…" : "Upload CSV/XLSX"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="paste">Paste domains (one per line; optional “, MUU”)</Label>
            <Textarea id="paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"coindesk.com, 4.2M\ntheblock.co"} className="font-mono text-xs" />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!paste.trim()}
                onClick={() => {
                  const res = parseDomainText(paste);
                  mergeRows(res.rows);
                  setPaste("");
                  toast.success(`${res.rows.length} domains added${res.invalid.length ? `, ${res.invalid.length} invalid skipped` : ""}`);
                }}
              >
                Add to list
              </Button>
              {list.length ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setList([])}>
                  Clear list
                </Button>
              ) : null}
            </div>
            {list.length ? (
              <div className="max-h-80 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-1 text-left text-xs text-muted">
                    <tr>
                      <th className="px-3 py-1.5">Domain ({list.length})</th>
                      <th className="w-28 px-3 py-1.5 sm:w-40">Manual MUU</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, 300).map((r) => (
                      <tr key={r.domain} className="border-t border-border">
                        <td className="break-all px-3 py-1 font-mono text-xs text-body">{r.domain}</td>
                        <td className="px-3 py-1">
                          <Input
                            aria-label={`Manual MUU for ${r.domain}`}
                            className="h-7 text-xs"
                            defaultValue={r.muu != null ? fmtNumber(r.muu) : ""}
                            placeholder="unknown"
                            onBlur={(e) => {
                              const v = e.target.value.trim() ? parseAudience(e.target.value) : null;
                              setList((prev) => prev.map((x) => (x.domain === r.domain ? { ...x, muu: v } : x)));
                            }}
                          />
                        </td>
                        <td className="px-1">
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${r.domain}`} onClick={() => setList((prev) => prev.filter((x) => x.domain !== r.domain))}>
                            <Trash2 />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {list.length > 300 ? <p className="px-3 py-2 text-xs text-muted">Showing 300 of {list.length}. Each run scores up to {maxDomainsPerRun}; weekly/next runs continue with the rest.</p> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Cost & run</CardTitle>
              <CardDescription>Estimated before every run; blocked if it would exceed your or the org’s Apify budget.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!apifyConnected && needsApify ? <p className="text-xs text-secondary">Discovery filters need Apify. Without it, only the domain list is scored.</p> : null}
            {estimate ? (
              <>
                <CostEstimate lines={estimate.lines} budget={estimate.budget} entity="scout_search" entityId={initial?.id} />
                <p className="text-xs text-muted">
                  ~{estimate.domainsExpected} domains this run (max {maxDomainsPerRun})
                  {estimate.cappedDomains ? `; ${estimate.cappedDomains} more wait for the next run` : ""}.
                </p>
              </>
            ) : (
              <Button type="button" size="sm" className="w-full" disabled={busy !== null} onClick={doEstimate}>
                {busy === "estimate" ? "Estimating…" : "Estimate cost"}
              </Button>
            )}
            <div className="flex flex-col gap-2 pt-1">
              <Button type="button" variant="primary" disabled={busy !== null || (estimate != null && !estimate.budget.allowed)} onClick={() => save(true)}>
                {busy === "run" ? "Starting…" : "Save & run"}
              </Button>
              <Button type="button" disabled={busy !== null} onClick={() => save(false)}>
                {busy === "save" ? "Saving…" : "Save only"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function Field({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string[]; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error?.length ? (
        <p className="text-xs text-secondary" role="alert">
          {error[0]}
        </p>
      ) : null}
    </div>
  );
}
