/**
 * REAL DATA MIGRATION (PRD §18) — imports the four RTB pipeline workbooks into the CRM.
 *
 *   npx tsx scripts/import-spreadsheets.ts            # commit (one import_batches row per source file)
 *   npx tsx scripts/import-spreadsheets.ts --dry-run  # resolve everything, write nothing
 *
 * Idempotent: accounts upsert by normalized domain (fallback name), one deal per account per pipeline, contacts by
 * email / account+name, notes and metrics by content key. Re-running only fills gaps. Each file's batch can be rolled
 * back from /import/history. Writes a reconciliation report to docs/IMPORT_REPORT.md.
 *
 * Rules (from the brief): tier → stage (1→contract, 0.9→hot, 0.5→in_comms, 0.1→target) unless the unversioned
 * [DRAFT] file has a granular Status (preferred); DRAFT probability overrides → pending approval; Arena/Paradium.AI →
 * ENT + restricted; dedupe priority Strategic > Active > Pipeline, keep most advanced stage, fill empty fields only;
 * every deal gets a next step due import date + 7 days and the "imported" tag; notes → activities (source import).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { nameFromEmail } from "../src/lib/contacts/seniority";
import { normalizeDomain, parseAudience } from "../src/lib/domain";
import { cellText, extractEmails, isLinkedinUrl, isUrl, parseBool, parseLooseDate, parseMarketCapUsd, sectionLabel, type CellValue } from "../src/lib/import/cells";
import { normalizeName, sourcePriority, stripCorporateSubdomain } from "../src/lib/import/dedupe";
import { mergeAccounts, mergeDeals } from "../src/lib/accounts/merge";
import { ImportEngine, domainIsName, typesCompatible, type BatchStats } from "../src/lib/import/engine";
import { normalizeFields, parseRelationshipCell, type NormalizeContext, type NormalizedContact, type NormalizedRecord } from "../src/lib/import/normalize";
import { KNOWN_REPS, placeholderEmail } from "../src/lib/import/owners";
import { createStageMatcher, stageRank, type StatusMatch } from "../src/lib/import/status";
import { readXlsxFile, type SheetData } from "../src/lib/import/workbook";

const FILES = {
  v7: "/Users/hossamhamdy/Downloads/RTB Data Room - 2026 3/RTB Global Sales Pipeline 9.29.26 [DRAFT] v7 (ranked by MUU).xlsx",
  draft: "/Users/hossamhamdy/Downloads/RTB Global Sales Pipeline 9.29.26 [DRAFT].xlsx",
  cw: "/Users/hossamhamdy/Downloads/Chris & Will - Roundtable_Master_Pipeline (1).xlsx",
  sites: "/Users/hossamhamdy/Downloads/RTB Sites & RTB100 Pipeline (Top 100 list + Media sites_ Crypto, Blockchain, Finance, AI, Politics, Military).xlsx",
};

const DRY = process.argv.includes("--dry-run");
/** --only=v7,draft,cw,sites (default: all). Later files still use v7's pipeline routing. */
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? "v7,draft,cw,sites").split(",");
const IMPORT_DATE = new Date();
const OVERRIDE_REASON = "Imported: per J. Heckman 29 Sep 2026";
/** ENT routing beyond the Strategic sources (PRD §4 names HT Media as an enterprise group). */
const ENT_NAMED = new Set(["newyorkpost", "nypost", "reach", "reachplc", "baltimoresun", "sinclair", "gbnews", "htmedia"]);
const CRYPTO_TLD = /\.(finance|network|io|xyz|foundation|technology|fi|exchange|money|protocol|chain|trade)(\/|$)/i;

type Cells = CellValue[];
const c = (row: Cells, col: number): CellValue => row[col - 1] ?? null;
const t = (row: Cells, col: number): string | null => cellText(c(row, col));

/* ───────────── reporting state ───────────── */

const report = {
  batches: [] as { file: string; batchId: string; stats: BatchStats; unmapped: Record<string, number> }[],
  sheetRows: [] as { file: string; sheet: string; rows: number; records: number; deals: number; skipped: number }[],
  skipped: [] as { sheet: string; row: number; reason: string }[],
  unmatched: [] as { sheet: string; name: string; reason: string }[],
  statusNotes: new Map<string, number>(),
  notes: [] as string[],
  summaryTargets: [] as { section: string; label: string; count: number | null; value: number | null }[],
  teamCheck: [] as { name: string; sheet: string; seeded: string }[],
};

function sheetOf(wb: SheetData[], name: string): SheetData {
  const sh = wb.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!sh) throw new Error(`Sheet not found: ${name}`);
  return sh;
}

function isBlank(row: Cells | undefined) {
  return !row || !row.some((x) => cellText(x) != null);
}

/* ───────────── engine helpers ───────────── */

let engine: ImportEngine;
const matchers = new Map<string, (raw: unknown) => StatusMatch>();

/** ENT has fewer stages than the MUU pipelines; statuses like "Warming up"/"Demo"/"Old Lead" translate via NET. */
const NET_TO_ENT: Record<string, string> = { target: "target", outreach: "outreach", in_comms: "in_comms", warming: "in_comms", hot: "negotiation", demo: "proposal", contract: "contract", migrating: "won", live: "won", on_hold: "on_hold", cold: "cold", lost: "lost" };

function matcher(pipelineKey: string) {
  if (!matchers.has(pipelineKey)) {
    const own = createStageMatcher(engine.stagesFor(pipelineKey));
    if (pipelineKey === "ENT") {
      const net = createStageMatcher(engine.stagesFor("NET"));
      matchers.set(pipelineKey, (raw: unknown) => {
        const m = own(raw);
        if (m.kind !== "unmapped") return m;
        const n = net(raw);
        return n.kind === "stage" ? { ...n, stageKey: NET_TO_ENT[n.stageKey] ?? "in_comms" } : m;
      });
    } else matchers.set(pipelineKey, own);
  }
  return matchers.get(pipelineKey)!;
}

function ctx(pipelineKey: string, source: string, extra: Partial<NormalizeContext> = {}): NormalizeContext {
  const target = pipelineKey === "R100" ? "r100" : pipelineKey === "ADS" ? "ads" : "accounts_deals";
  return { target, pipelineKey, source, matchStatus: matcher(pipelineKey), importDate: IMPORT_DATE, visitsPerUnique: 2.5, ...extra };
}

let debugPrinted = 0; // DEBUG_SHEET="RTB 100 MASTER" DEBUG_N=10 prints normalized records for one sheet

type SheetCounter ={ records: number; deals: number; skipped: number };
function counter(): SheetCounter {
  return { records: 0, deals: 0, skipped: 0 };
}

function applyRec(rec: NormalizedRecord | null, sheet: string, row: number, cnt: SheetCounter, why = "no name / domain") {
  if (!rec) {
    cnt.skipped++;
    report.skipped.push({ sheet, row, reason: why });
    return null;
  }
  if (rec.statusNote) {
    const k = `${rec.statusNote.kind}: ${rec.statusNote.raw.slice(0, 60)}`;
    report.statusNotes.set(k, (report.statusNotes.get(k) ?? 0) + 1);
  }
  // Arena Group / Paradium.AI is under an MNPI-sensitive platform agreement: every record about it is restricted.
  if (/arena group|paradium/i.test(rec.account.name)) {
    rec.account.restricted = true;
    if (rec.deal) rec.deal.restricted = true;
  }
  // Removed/disqualified accounts keep their contacts & notes but get no new early-stage deals from list sheets.
  if (rec.deal) {
    const existing = engine.findAccount(rec.account);
    const early = !rec.deal.stageKey || ["target", "outreach", "cold", "lost"].includes(rec.deal.stageKey);
    if (existing?.row.lifecycle === "disqualified" && early && rec.deal.pipelineKey !== "R100" && rec.deal.pipelineKey !== "ADS") rec.deal = null;
  }
  const out = engine.apply(rec);
  if (process.env.DEBUG_CREATES && out && (out.account === "create" || out.deal === "create")) console.log(`    + ${sheet} r${row}: ${out.accountName} account=${out.account} deal=${out.deal} (${rec.account.type}, ${rec.account.domain ?? "no domain"})`);
  if (process.env.DEBUG_SHEET === sheet && debugPrinted < Number(process.env.DEBUG_N ?? 6)) {
    debugPrinted++;
    console.log(JSON.stringify({ rec, out }));
  }
  cnt.records++;
  if (rec.deal) cnt.deals++;
  return out;
}

function finishSheet(file: string, sheet: string, rows: number, cnt: SheetCounter) {
  report.sheetRows.push({ file, sheet, rows, ...cnt });
  console.log(`  · ${sheet}: ${rows} rows → ${cnt.records} records, ${cnt.deals} with deals, ${cnt.skipped} skipped`);
}

async function flush(file: string) {
  const res = await engine.flush({ dryRun: DRY, log: (m) => console.log(m) });
  report.batches.push({ file, batchId: res.batchId, stats: res.stats, unmapped: res.unmapped });
  console.log(`  ✓ batch ${res.batchId}${DRY ? " (dry run)" : ""}`, JSON.stringify(res.stats));
}

/* ───────────── field helpers ───────────── */

function splitSportsCategory(cat: string | null): { category: string | null; league: string | null } {
  if (!cat) return { category: null, league: null };
  const m = cat.match(/^sports?\s*[–—-]\s*(.+)$/i);
  if (m) return { category: "Sports", league: m[1]!.trim() === "All" ? null : m[1]!.trim() };
  if (/^sports?$/i.test(cat.trim())) return { category: "Sports", league: null };
  return { category: cat, league: null };
}

function mapVertical(v: string | null): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/crypto|bitcoin|blockchain/.test(s)) return "Crypto";
  if (/cyber/.test(s)) return "Cyber Security";
  if (/invest|financ|forex|market|stock|macro|mortgage|advisor|hedge|small.?cap|economics|precious|commodit|mining|resource/.test(s)) return "Finance";
  if (/defen[cs]e|military|aviation|space|drone/.test(s)) return "Space/Aviation/Military";
  if (/health|pharma|biotech|medical/.test(s)) return "Healthcare";
  if (/politic/.test(s)) return "Politics";
  if (/news/.test(s)) return "News";
  if (/science|chemistry/.test(s)) return "Math/Science";
  if (/energy|solar|climate|oil|gas|agricultur|produce/.test(s)) return "Sustainability";
  if (/\bai\b|artificial/.test(s)) return "AI";
  if (/tech|semiconductor|electronic|hardware|software|cloud|linux|storage|server|android|apple|computing|dev\b/.test(s)) return "Emerging Tech";
  if (/auto|ev|car/.test(s)) return "Consumer Tech";
  if (/travel|adventure|expedition/.test(s)) return "Travel/Adventure";
  if (/music|watch|lifestyle/.test(s)) return "Lifestyle";
  if (/real estate|cre\b/.test(s)) return "Real Estate";
  return null;
}

/** Title-ish text next to an email in the messy R100 sheets. */
function looksLikeTitle(s: string | null): boolean {
  return !!s && s.length <= 80 && !isUrl(s) && !extractEmails(s).length && !/^\$|^\d/.test(s) && !/^(yes|no|like|dislike|in progress)$/i.test(s) && !/outreach|follow/i.test(s);
}

/** Collect contacts from a run of cells (email cells, each optionally followed by a title cell). */
function contactsFromCells(row: Cells, from: number, to: number, exclude: Set<string>): NormalizedContact[] {
  const out: NormalizedContact[] = [];
  for (let col = from; col <= to; col++) {
    const raw = t(row, col);
    if (!raw) continue;
    const emails = extractEmails(raw);
    if (!emails.length) continue;
    const next = t(row, col + 1);
    let title = looksLikeTitle(next) ? next : null;
    for (const e of emails) {
      if (exclude.has(e)) continue;
      exclude.add(e);
      const namePart = raw.replace(/[\w.+'-]+@[\w.-]+/g, "").replace(/[-–,:]/g, " ").trim();
      let fullName = namePart && namePart.split(/\s+/).length <= 4 && /[a-z]/i.test(namePart) ? namePart : nameFromEmail(e);
      // "Sunil, SVP Marketing" in the title cell → first name + title
      const nt = title?.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)?),\s*(.+)$/);
      if (nt && fullName === nameFromEmail(e)) {
        fullName = nt[1]!;
        title = nt[2]!;
      }
      out.push({ fullName, email: e, title });
    }
  }
  return out;
}

/* ═════════════════════════ 1) v7 workbook (+ DRAFT status join) ═════════════════════════ */

type DraftInfo = { status: string | null; override: number | null; rowNumber: number; name: string; domain: string | null; rep: string | null; priority: string | null; poc: string | null; pocContact: string | null; title: string | null; notes: string | null; nextSteps: string | null; category: string | null; muu: CellValue; source: string | null };
const draftByKey = new Map<string, DraftInfo>();
const v7Keys = new Set<string>();
const pmPipelineByKey = new Map<string, string>();

function keysOf(name: string | null, domain: string | null): string[] {
  const out: string[] = [];
  const d = normalizeDomain(domain);
  if (d) out.push(`d:${d}`);
  const n = normalizeName(name);
  if (n) out.push(`n:${n}`);
  return out;
}

function lookupDraft(name: string | null, domain: string | null): DraftInfo | null {
  for (const k of keysOf(name, domain)) {
    const hit = draftByKey.get(k);
    if (hit) return hit;
  }
  return null;
}

async function loadDraft() {
  const wb = await readXlsxFile(FILES.draft);
  const pm = sheetOf(wb, "Pipeline Master");
  for (let i = 1; i < pm.rows.length; i++) {
    const row = pm.rows[i]!;
    const name = t(row, 1);
    if (!name) continue;
    const override = typeof c(row, 18) === "number" ? (c(row, 18) as number) : null;
    const info: DraftInfo = {
      status: t(row, 4),
      override,
      rowNumber: i + 1,
      name,
      domain: t(row, 2),
      priority: t(row, 3),
      muu: c(row, 5),
      category: t(row, 7),
      poc: t(row, 8),
      pocContact: t(row, 9),
      title: t(row, 10),
      notes: t(row, 11),
      nextSteps: t(row, 12),
      rep: t(row, 15),
      source: t(row, 16),
    };
    for (const k of keysOf(name, info.domain)) if (!draftByKey.has(k)) draftByKey.set(k, info);
  }
  console.log(`DRAFT Pipeline Master: ${new Set(draftByKey.values()).size} rows indexed for status/override`);
}

function v7Pipeline(name: string, source: string | null, category: string | null, muu: number | null): { key: string; restricted: boolean } {
  if (/arena group|paradium/i.test(name)) return { key: "ENT", restricted: true };
  if (ENT_NAMED.has(normalizeName(name))) return { key: "ENT", restricted: false };
  if ((category && /^sports?/i.test(category)) || source === "Sports") return { key: "SPT", restricted: false };
  // D7: 10M+ MUU brands from the strategic / active sources are enterprise deals
  if (source && /strategic|closed|active/i.test(source) && (muu ?? 0) >= 10_000_000) return { key: "ENT", restricted: false };
  return { key: "NET", restricted: false };
}

function pipelineFor(name: string | null, domain: string | null, fallback: string): string {
  for (const k of keysOf(name, domain)) {
    const p = pmPipelineByKey.get(k);
    if (p) return p;
  }
  return fallback;
}

/** Pipeline routing per account key, decided once from v7 Pipeline Master and reused by every other tab/file. */
function prepareV7Keys(pm: SheetData) {
  for (let i = 1; i < pm.rows.length; i++) {
    const row = pm.rows[i]!;
    const name = t(row, 1);
    if (!name) continue;
    const p = v7Pipeline(name, t(row, 8), t(row, 3), parseAudience(c(row, 5)));
    for (const k of keysOf(name, t(row, 2))) {
      v7Keys.add(k);
      if (!pmPipelineByKey.has(k)) pmPipelineByKey.set(k, p.key);
    }
  }
}

async function importV7(wb: SheetData[]) {
  const file = basename(FILES.v7);
  console.log(`\n▶ ${file}`);
  engine.beginBatch({ fileName: file, sheetName: "Pipeline Master, Contacts & Notes, Strategic, Sports, TechFinance, NewsPolitics, RTB 100, MigrationPrio, Removed (off model)", target: "accounts_deals", pipelineKey: null, mapping: { note: "scripts/import-spreadsheets.ts" } });

  const pm = sheetOf(wb, "Pipeline Master");
  const cn = sheetOf(wb, "Contacts & Notes");
  const cnByName = new Map<string, Cells>();
  for (let i = 1; i < cn.rows.length; i++) {
    const n = normalizeName(t(cn.rows[i]!, 1));
    if (n && !cnByName.has(n)) cnByName.set(n, cn.rows[i]!);
  }

  // Pipeline Master rows (joined with Contacts & Notes + DRAFT status), sorted by source priority
  type PmRow = { rowNumber: number; row: Cells; name: string; source: string | null };
  const pmRows: PmRow[] = [];
  for (let i = 1; i < pm.rows.length; i++) {
    const row = pm.rows[i]!;
    const name = t(row, 1);
    if (!name) continue;
    pmRows.push({ rowNumber: i + 1, row, name, source: t(row, 8) });
  }
  pmRows.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || a.rowNumber - b.rowNumber);

  // 1a. Strategic tab first (highest source priority)
  {
    const sh = sheetOf(wb, "Strategic");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (isBlank(row)) continue;
      const name = t(row, 1);
      const key = pipelineFor(name, t(row, 2), "NET");
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.domain": t(row, 2),
          "deal.priority": c(row, 3),
          "deal.status": c(row, 4),
          "audience.muu": c(row, 5),
          "account.category": c(row, 6),
          "contact.name": c(row, 7),
          "contact.email": c(row, 8),
          "contact.title": c(row, 9),
          "deal.notes": c(row, 10),
        },
        i + 1,
        ctx(key, "Strategic", { audienceSource: "Strategic tab", audienceConfidence: "reported" }),
      );
      if (rec?.deal) rec.deal.customFields = { originalSource: "Strategic" };
      applyRec(rec, "Strategic", i + 1, cnt);
    }
    finishSheet(file, "Strategic", sh.rows.length - 1, cnt);
  }

  // 1b. Pipeline Master
  {
    const cnt = counter();
    let overrides = 0;
    let draftStatusUsed = 0;
    for (const { rowNumber, row, name, source } of pmRows) {
      const domain = t(row, 2);
      const { category, league } = splitSportsCategory(t(row, 3));
      const p = v7Pipeline(name, source, t(row, 3), parseAudience(c(row, 5)));
      const draft = lookupDraft(name, domain);
      const cnRow = normalizeName(t(cn.rows[rowNumber - 1] ?? [], 1)) === normalizeName(name) ? cn.rows[rowNumber - 1]! : cnByName.get(normalizeName(name));
      const blue = pm.fontColors?.get(`${rowNumber}:5`) === "FF0000FF";
      const isVisits = source === "NetDev Pipeline" && !blue; // DRAFT note: NetDev Pipeline "Monthly visits" were imported as MUU
      const muu = c(row, 5);
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.domain": domain,
          "account.category": category,
          "account.league": league,
          "deal.tier": c(row, 4),
          "deal.status": draft?.status ?? null,
          "deal.probabilityOverride": draft?.override ?? null,
          "deal.owner": t(row, 10) ?? (cnRow ? t(cnRow, 8) : null),
          "deal.priority": cnRow ? c(cnRow, 2) : null,
          "contact.name": cnRow ? c(cnRow, 3) : null,
          "contact.email": cnRow ? c(cnRow, 4) : null,
          "contact.title": cnRow ? c(cnRow, 5) : null,
          "deal.notes": cnRow ? c(cnRow, 6) : null,
          "deal.nextStep": cnRow ? c(cnRow, 7) : null,
          [isVisits ? "audience.visits" : "audience.muu"]: muu,
        },
        rowNumber,
        ctx(p.key, "Pipeline Master", {
          audienceSource: blue ? "BFF research estimate" : isVisits ? "pipeline v7 (NetDev monthly visits)" : "pipeline v7",
          audienceConfidence: blue ? "estimate" : "reported",
        }),
      );
      if (rec?.deal) {
        if (draft?.status) draftStatusUsed++;
        rec.deal.customFields = { originalSource: source, tier: c(row, 4) };
        if (rec.deal.probabilityOverride != null) {
          overrides++;
          rec.deal.overrideReason = OVERRIDE_REASON;
          rec.deal.overrideStatus = "pending";
        }
        if (p.restricted) {
          rec.deal.restricted = true;
          rec.account.restricted = true;
          rec.account.type = "media_group";
        }
        if (p.key === "ENT") rec.account.type = "media_group";
      }
      applyRec(rec, "Pipeline Master", rowNumber, cnt);
    }
    finishSheet(file, "Pipeline Master (+Contacts & Notes, DRAFT status)", pmRows.length, cnt);
    report.notes.push(`Pipeline Master: DRAFT granular status used for ${draftStatusUsed} rows (tier fallback for the rest); ${overrides} probability overrides imported as pending approval (“${OVERRIDE_REASON}”).`);
  }

  // 1c. Sports tab
  {
    const sh = sheetOf(wb, "Sports");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (isBlank(row) || !t(row, 1)) continue;
      const rec = normalizeFields(
        {
          "account.name": c(row, 1),
          "account.domain": t(row, 2),
          "account.team": c(row, 3),
          "account.league": c(row, 4),
          "account.category": "Sports",
          "deal.priority": c(row, 5),
          "deal.status": c(row, 6),
          "audience.muu": c(row, 7),
          "deal.owner": c(row, 8),
          "contact.name": c(row, 9),
          "contact.email": c(row, 10),
          "contact.title": c(row, 11),
          "deal.notes": c(row, 12),
        },
        i + 1,
        ctx(pipelineFor(t(row, 1), t(row, 2), "SPT"), "Sports", { audienceSource: "Sports tab", audienceConfidence: "reported" }),
      );
      if (rec?.account.league === "All") rec.account.league = null;
      applyRec(rec, "Sports", i + 1, cnt);
    }
    finishSheet(file, "Sports", sh.rows.length - 1, cnt);
  }

  // 1d. TechFinance / NewsPolitics
  for (const [name, cols] of [
    ["TechFinance", { status: 3, category: 4, muu: 5 }],
    ["NewsPolitics", { status: 3, muu: 4, category: 5 }],
  ] as const) {
    const sh = sheetOf(wb, name);
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (isBlank(row) || !t(row, 1)) continue;
      const rec = normalizeFields(
        {
          "account.name": c(row, 1),
          "account.domain": t(row, 2),
          "deal.status": c(row, cols.status),
          "account.category": c(row, cols.category),
          "audience.muu": c(row, cols.muu),
          "deal.owner": c(row, 6),
          "contact.name": c(row, 7),
          "contact.email": c(row, 8),
          "contact.title": c(row, 9),
          "deal.notes": c(row, 10),
        },
        i + 1,
        ctx(pipelineFor(t(row, 1), t(row, 2), "NET"), name, { audienceSource: `${name} tab`, audienceConfidence: "reported" }),
      );
      applyRec(rec, name, i + 1, cnt);
    }
    finishSheet(file, name, sh.rows.length - 1, cnt);
  }

  // 1e. RTB 100 activation tracker
  {
    const sh = sheetOf(wb, "RTB 100");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const name = t(row, 1);
      if (!name) continue;
      const rec = normalizeFields(
        {
          "account.name": name,
          "r100.firstPostDate": c(row, 2),
          "r100.m1": c(row, 3),
          "r100.m2": c(row, 4),
          "r100.m3": c(row, 5),
          "r100.postCount": c(row, 6),
          "r100.profileUrl": c(row, 7),
          "deal.owner": c(row, 8),
          "r100.editorialLink": [c(row, 10), c(row, 11), c(row, 12), c(row, 13), c(row, 14)],
        },
        i + 1,
        ctx("R100", "RTB 100", { accountType: "public_company" }),
      );
      if (rec?.deal) {
        rec.deal.stageKey = rec.deal.r100?.firstPostDate ? "first_post" : rec.deal.r100?.profileUrl ? "profile_activated" : "onboarding";
        const interview = t(row, 9);
        if (interview && isUrl(interview)) rec.deal.customFields = { interviewUrl: interview };
      }
      applyRec(rec, "RTB 100", i + 1, cnt);
    }
    finishSheet(file, "RTB 100", sh.rows.length - 1, cnt);
  }

  // 1f. Removed (off model) → accounts, lifecycle disqualified (reason kept)
  {
    const sh = sheetOf(wb, "Removed (off model)");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (!t(row, 1)) continue;
      const src = t(row, 7);
      const rec = normalizeFields(
        {
          "account.name": c(row, 1),
          "account.domain": t(row, 2),
          "account.category": c(row, 3),
          [src === "NetDev Pipeline" ? "audience.visits" : "audience.muu"]: c(row, 5),
        },
        i + 1,
        ctx("NET", "Removed (off model)", { audienceSource: src === "NetDev Pipeline" ? "pipeline v7 (NetDev monthly visits)" : "pipeline v7", audienceConfidence: "reported" }),
      );
      if (rec) {
        rec.deal = null;
        rec.account.lifecycle = "disqualified";
        rec.account.notes = `Removed from pipeline model: ${t(row, 6) ?? "no reason given"}`;
        rec.account.customFields = { removedReason: t(row, 6), tierBefore: c(row, 4), originalSource: src };
      }
      applyRec(rec, "Removed (off model)", i + 1, cnt);
    }
    finishSheet(file, "Removed (off model)", sh.rows.length - 1, cnt);
  }

  // 1g. MigrationPrio → migration projects
  {
    const sh = sheetOf(wb, "MigrationPrio");
    const cnt = counter();
    const ALIAS: Record<string, string> = {
      nypost: "New York Post",
      techdefused: "Techdefused",
      "polandtvrepublika": "TV Republika",
      proactiveinvestors: "Proactive",
    };
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const raw = t(row, 1);
      if (!raw) continue;
      const status = (t(row, 2) ?? "").toLowerCase();
      const launched = parseBool(c(row, 3)) === true;
      if (status === "no migration") {
        report.unmatched.push({ sheet: "MigrationPrio", name: raw, reason: "status “No Migration” — no project created" });
        continue;
      }
      const stage = launched ? "live" : status === "done" ? "qa" : status === "in process" ? "clone_built" : status === "paused" ? "paused" : "discovery";
      const cleaned = raw.replace(/\(.*?\)/g, "").trim();
      const nm = ALIAS[normalizeName(raw)] ?? ALIAS[normalizeName(cleaned)] ?? cleaned;
      const domain = normalizeDomain(cleaned);
      const res = engine.applyMigration({ name: nm, domain, stage, launched, notes: t(row, 4) ?? `Imported from MigrationPrio (${t(row, 2)})`, rowNumber: i + 1, source: "MigrationPrio" });
      if (!res.matched) {
        // create a minimal account (no deal) so the project isn't lost
        const rec = normalizeFields({ "account.name": nm, "account.domain": domain }, i + 1, ctx("NET", "MigrationPrio"));
        if (rec) rec.deal = null;
        applyRec(rec, "MigrationPrio", i + 1, cnt);
        const created = engine.findAccount({ name: nm, domain });
        if (created) {
          const cur = (created.row.lifecycle as string) ?? "target";
          if (cur === "target") created.row.lifecycle = "customer";
        }
        engine.applyMigration({ name: nm, domain, stage, launched, notes: t(row, 4) ?? `Imported from MigrationPrio (${t(row, 2)})`, rowNumber: i + 1, source: "MigrationPrio" });
        report.unmatched.push({ sheet: "MigrationPrio", name: raw, reason: "no matching account — created a new account for the project" });
      }
      cnt.records++;
    }
    finishSheet(file, "MigrationPrio", sh.rows.length - 1, cnt);
  }

  await flush(file);
}

/* ═════════════════════════ 2) DRAFT workbook (rows missing from v7) ═════════════════════════ */

async function importDraftExtras(removedKeys: Set<string>) {
  const file = basename(FILES.draft);
  console.log(`\n▶ ${file}`);
  engine.beginBatch({ fileName: file, sheetName: "Pipeline Master (rows not in v7)", target: "accounts_deals", pipelineKey: null, mapping: { note: "status/override joined into v7; this batch only holds rows absent from v7" } });
  const cnt = counter();
  const seen = new Set<DraftInfo>();
  let inRemoved = 0;
  for (const info of draftByKey.values()) {
    if (seen.has(info)) continue;
    seen.add(info);
    const keys = keysOf(info.name, info.domain);
    if (keys.some((k) => v7Keys.has(k))) continue;
    if (keys.some((k) => removedKeys.has(k))) {
      inRemoved++;
      continue;
    }
    const { category, league } = splitSportsCategory(info.category);
    const p = v7Pipeline(info.name, info.source, info.category, parseAudience(info.muu));
    const rec = normalizeFields(
      {
        "account.name": info.name,
        "account.domain": info.domain,
        "account.category": category,
        "account.league": league,
        "deal.status": info.status,
        "deal.probabilityOverride": info.override,
        "deal.owner": info.rep,
        "deal.priority": info.priority,
        "contact.name": info.poc,
        "contact.email": info.pocContact,
        "contact.title": info.title,
        "deal.notes": info.notes,
        "deal.nextStep": info.nextSteps,
        [info.source === "NetDev Pipeline" ? "audience.visits" : "audience.muu"]: info.muu,
      },
      info.rowNumber,
      ctx(p.key, "Pipeline Master (DRAFT)", { audienceSource: "pipeline DRAFT", audienceConfidence: "reported" }),
    );
    if (rec?.deal && rec.deal.probabilityOverride != null) {
      rec.deal.overrideReason = OVERRIDE_REASON;
      rec.deal.overrideStatus = "pending";
    }
    if (rec?.deal && p.restricted) {
      rec.deal.restricted = true;
      rec.account.restricted = true;
    }
    applyRec(rec, "Pipeline Master (DRAFT)", info.rowNumber, cnt);
  }
  finishSheet(file, "Pipeline Master (DRAFT, not in v7)", seen.size, cnt);
  report.notes.push(`DRAFT Pipeline Master: ${seen.size} rows; statuses/overrides joined into v7 rows; ${inRemoved} rows are in v7 “Removed (off model)” (not re-added); ${cnt.records} rows absent from v7 imported here.`);
  await flush(file);
}

/* ═════════════════════════ 3) Chris & Will master ═════════════════════════ */

async function importCW() {
  const file = basename(FILES.cw);
  console.log(`\n▶ ${file}`);
  const wb = await readXlsxFile(FILES.cw);
  engine.beginBatch({ fileName: file, sheetName: "TheStreet, NetDev, RTB 100, Team, Summary", target: "ads", pipelineKey: null, mapping: { note: "scripts/import-spreadsheets.ts" } });

  // Summary → validation targets
  {
    const sh = sheetOf(wb, "Summary");
    let section = "";
    for (const row of sh.rows) {
      const label = t(row, 1);
      if (!label) continue;
      if (/^[A-Z0-9 ()]+$/.test(label.replace(/[^A-Za-z0-9 ()]/g, "")) && label === label.toUpperCase() && !/TOTAL/.test(label)) {
        section = label;
        continue;
      }
      const num = (v: CellValue) => (typeof v === "number" ? v : null);
      if (row.length > 1) report.summaryTargets.push({ section, label: label.trim(), count: num(c(row, 2)), value: num(c(row, 3)) });
    }
  }

  // Team → employment types (placeholders are seeded from the same data in src/lib/import/owners.ts)
  {
    const sh = sheetOf(wb, "Team");
    for (let i = 1; i < sh.rows.length; i++) {
      const name = t(sh.rows[i]!, 1);
      const hr = t(sh.rows[i]!, 2);
      if (!name) continue;
      const first = name.split(/\s+/)[0]!;
      const known = KNOWN_REPS[first];
      report.teamCheck.push({ name, sheet: hr ?? "", seeded: known?.employmentType ?? "—" });
    }
  }

  // TheStreet → ADS deals
  {
    const sh = sheetOf(wb, "TheStreet");
    const cnt = counter();
    for (let i = 4; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const cat = t(row, 1);
      const name = t(row, 2);
      if (!cat || !name || !/active deal|current client|warm deal/i.test(cat)) continue;
      const status = t(row, 5);
      const rec = normalizeFields(
        { "account.name": name, "deal.status": status, "deal.notes": c(row, 6) },
        i + 1,
        ctx("ADS", "TheStreet", { accountType: "advertiser" }),
      );
      if (rec?.deal) {
        const next = typeof c(row, 3) === "number" ? Math.round((c(row, 3) as number) * 100) : null;
        const annual = typeof c(row, 4) === "number" ? Math.round((c(row, 4) as number) * 100) : null;
        if (/active deal/i.test(cat)) {
          const m = matcher("ADS")(status);
          const k = m.kind === "stage" ? m.stageKey : null;
          rec.deal.stageKey = k && ["verbal", "loi", "negotiation"].includes(k) ? k : "negotiation";
          rec.deal.contractValueCents = next;
          rec.deal.nextPaymentCents = next;
          rec.deal.annualizedValueCents = annual;
          rec.deal.tags = ["active_deal"];
        } else if (/current client/i.test(cat)) {
          rec.deal.stageKey = "current_client";
          rec.deal.nextPaymentCents = next;
          rec.deal.annualizedValueCents = annual;
          rec.deal.contractValueCents = annual;
          rec.deal.tags = ["current_client"];
        } else {
          rec.deal.stageKey = "warm";
          rec.deal.annualizedValueCents = annual;
          rec.deal.tags = ["warm_deal"];
        }
        rec.deal.customFields = { adsCategory: cat };
        rec.deal.owners = ["Chris", "Will"];
      }
      applyRec(rec, "TheStreet", i + 1, cnt);
    }
    finishSheet(file, "TheStreet", sh.rows.length - 4, cnt);
  }

  // NetDev → NET deals (dedupe against v7)
  {
    const sh = sheetOf(wb, "NetDev");
    const cnt = counter();
    for (let i = 4; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const name = t(row, 1);
      if (!name || !t(row, 2) || name.length > 80) continue;
      const rec = normalizeFields(
        {
          "account.name": name,
          "deal.status": c(row, 2),
          "audience.muu": c(row, 3),
          "account.category": c(row, 4),
          "deal.owner": c(row, 5),
          "contact.name": c(row, 6),
          "contact.email": c(row, 7),
          "contact.title": c(row, 8),
          "deal.notes": c(row, 9),
        },
        i + 1,
        ctx(pipelineFor(name, null, "NET"), "C&W NetDev", { audienceSource: "C&W tracker (8/19)", audienceConfidence: "reported" }),
      );
      if (rec?.deal) {
        rec.deal.tags = ["cw_netdev"];
        rec.deal.customFields = { cwStatus: t(row, 2) };
      }
      applyRec(rec, "NetDev (C&W)", i + 1, cnt);
    }
    finishSheet(file, "NetDev", sh.rows.length - 4, cnt);
  }

  // RTB 100 → R100 deals
  {
    const sh = sheetOf(wb, "RTB 100");
    const cnt = counter();
    for (let i = 4; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const name = t(row, 1);
      if (!name || name.length > 80 || !t(row, 3)) continue;
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.ticker": c(row, 2),
          "deal.status": c(row, 3),
          "deal.owner": c(row, 4),
          "contact.relationship": c(row, 5),
          "deal.notes": c(row, 6),
        },
        i + 1,
        ctx("R100", "C&W RTB 100", { accountType: "public_company" }),
      );
      if (rec?.deal) {
        rec.deal.tags = ["cw_r100"];
        rec.deal.customFields = { cwStatus: t(row, 3) };
      }
      applyRec(rec, "RTB 100 (C&W)", i + 1, cnt);
    }
    finishSheet(file, "RTB 100", sh.rows.length - 4, cnt);
  }

  await flush(file);
}

/* ═════════════════════════ 4) RTB Sites & RTB100 workbook ═════════════════════════ */

function r100Stage(statusCell: CellValue, status2: string | null, outreach: string | null): { stageKey: string | null; lastContactedAt: Date | null; notes: string[] } {
  const m = matcher("R100");
  const notes: string[] = [];
  const st = m(statusCell);
  let stageKey: string | null = null;
  let lastContactedAt: Date | null = null;
  if (st.kind === "stage") {
    stageKey = st.stageKey;
    lastContactedAt = st.date;
  } else if (st.kind === "date") {
    stageKey = "outreach";
    lastContactedAt = st.date;
  } else if (st.kind !== "empty") notes.push(`Status cell: ${"raw" in st ? st.raw : ""}`);
  if (status2) {
    const s2 = m(status2);
    if (s2.kind === "stage" && !stageKey) stageKey = s2.stageKey;
    else if (s2.kind === "stage" && s2.stageKey === "relationship") notes.push("Relationship already");
    else if (s2.kind !== "stage" && s2.kind !== "empty") notes.push(status2);
  }
  if (outreach) {
    const o = m(outreach);
    if (!stageKey && (/outreach sent|^yes$|in progress/i.test(outreach) || o.kind === "date" || (o.kind === "stage" && o.stageKey === "outreach"))) {
      stageKey = "outreach";
      if (o.kind === "date" || o.kind === "stage") lastContactedAt = lastContactedAt ?? o.date;
    }
    if (/outreach sent from/i.test(outreach)) notes.push(outreach);
  }
  return { stageKey, lastContactedAt, notes };
}

async function importSites() {
  const file = basename(FILES.sites);
  console.log(`\n▶ ${file}`);
  const wb = await readXlsxFile(FILES.sites);
  engine.beginBatch({ fileName: file, sheetName: "NetDev Active/CLEANED/NETDEV Pipeline/New Target List/Spanish, RTB 100 MASTER, Editorial Outreach, Interviews", target: "accounts_deals", pipelineKey: null, mapping: { note: "scripts/import-spreadsheets.ts" } });

  // 4a. NetDev Active Deal Tracking
  {
    const sh = sheetOf(wb, "NetDev Active Deal Tracking");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (!t(row, 1)) continue;
      const rec = normalizeFields(
        {
          "account.name": c(row, 1),
          "account.domain": t(row, 2),
          "deal.status": c(row, 3),
          "audience.muu": c(row, 4),
          "account.category": c(row, 5),
          "deal.owner": c(row, 6),
          "contact.name": c(row, 7),
          "contact.email": c(row, 8),
          "contact.title": c(row, 9),
          "deal.notes": c(row, 10),
        },
        i + 1,
        ctx(pipelineFor(t(row, 1), t(row, 2), "NET"), "NetDev Active Deal Tracking", { audienceSource: "NetDev Active Deal Tracking", audienceConfidence: "reported" }),
      );
      applyRec(rec, "NetDev Active Deal Tracking", i + 1, cnt);
    }
    finishSheet(file, "NetDev Active Deal Tracking", sh.rows.length - 1, cnt);
  }

  // 4b. NetDev CLEANED Pipeline + NetDev Spanish Targets (same layout; Monthly visits → visits metric)
  for (const [sheetName, language] of [
    ["NetDev CLEANED Pipeline", null],
    ["NetDev Spanish Targets", "es"],
  ] as const) {
    const sh = sheetOf(wb, sheetName);
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const name = t(row, 1);
      if (!name || /do not modify/i.test(name) || sectionLabel(row)) continue;
      const outreach = t(row, 13);
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.domain": t(row, 2),
          "account.category": c(row, 3),
          "account.language": language,
          "audience.visits": c(row, 4),
          "deal.status": c(row, 5),
          "deal.owner": t(row, 6) ?? t(row, 7),
          "contact.name": c(row, 8),
          "contact.title": c(row, 9),
          "contact.email": c(row, 10),
          "deal.notes": [c(row, 11), outreach && /outreach sent/i.test(outreach) ? outreach : null],
          "contact.linkedin": c(row, 12),
        },
        i + 1,
        ctx(pipelineFor(name, t(row, 2), "NET"), sheetName, { audienceSource: `${sheetName} (monthly visits)` }),
      );
      if (rec?.deal && t(row, 7) && t(row, 6) && t(row, 7) !== t(row, 6)) rec.deal.customFields = { sourcedBy: t(row, 7) };
      applyRec(rec, sheetName, i + 1, cnt);
    }
    finishSheet(file, sheetName, sh.rows.length - 1, cnt);
  }

  // 4c. NETDEV Pipeline (older list with section rows: Rejections → lost)
  {
    const sh = sheetOf(wb, "NETDEV Pipeline");
    const cnt = counter();
    let section: string | null = null;
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (isBlank(row)) continue;
      const label = sectionLabel(row);
      const name = t(row, 1);
      const domain = t(row, 2);
      if (label || (name && /rejection/i.test(name) && !domain)) {
        section = label ?? name;
        continue;
      }
      const rejected = !!section && /rejection/i.test(section);
      const owner = t(row, 6) ?? t(row, 4);
      const status = t(row, 5);
      const hasWork = !!(status || owner || rejected);
      const rec = normalizeFields(
        {
          "account.name": name ?? domain,
          "account.domain": domain,
          "deal.notes": [c(row, 3), c(row, 17), t(row, 19) && !/^(yes|in progress)$/i.test(t(row, 19)!) ? c(row, 19) : null],
          "deal.status": rejected ? "rejected" : c(row, 5),
          "deal.owner": owner,
          "audience.visits": c(row, 7),
          "account.category": c(row, 8),
          "contact.name": c(row, 9),
          "contact.email": c(row, 10),
          "contact.title": c(row, 11),
          "contact.email2": c(row, 13),
          "contact.title2": c(row, 14),
        },
        i + 1,
        ctx(pipelineFor(name, domain, "NET"), "NETDEV Pipeline", { audienceSource: "NETDEV Pipeline (Similarweb monthly)" }),
      );
      if (rec && !hasWork) rec.deal = null; // prospect list row nobody is working yet → account only
      if (rec?.deal && section && !rejected) rec.deal.customFields = { section };
      applyRec(rec, "NETDEV Pipeline", i + 1, cnt);
    }
    finishSheet(file, "NETDEV Pipeline", sh.rows.length - 1, cnt);
  }

  // 4d. New Target List
  {
    const sh = sheetOf(wb, "New Target List");
    const cnt = counter();
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (!t(row, 2)) continue;
      const vertical = t(row, 4);
      const status = c(row, 1);
      const rec = normalizeFields(
        {
          "account.name": c(row, 2),
          "account.domain": t(row, 3),
          "account.category": mapVertical(vertical),
          "account.ownership": c(row, 6),
          "audience.muu": c(row, 5),
          "deal.status": status,
          "contact.name": c(row, 7),
          "contact.title": c(row, 8),
          "contact.email": c(row, 9),
          "deal.notes": c(row, 13),
        },
        i + 1,
        ctx(pipelineFor(t(row, 2), t(row, 3), "NET"), "New Target List", { audienceSource: "New Target List (est. uniques)", audienceConfidence: "estimate" }),
      );
      if (rec) {
        rec.account.subcategory = vertical;
        if (!cellText(status)) rec.deal = null; // not yet contacted → account only
      }
      applyRec(rec, "New Target List", i + 1, cnt);
    }
    finishSheet(file, "New Target List", sh.rows.length - 1, cnt);
  }

  // 4e. RTB 100 MASTER (~6,300 rows) — messy, shifted columns → custom extraction
  {
    const sh = sheetOf(wb, "RTB 100 MASTER");
    const cnt = counter();
    let accountsOnly = 0;
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const name = t(row, 1);
      if (!name || name.length > 120 || /back burner/i.test(name)) continue;
      const tickerRaw = t(row, 4);
      const ticker = tickerRaw && /^[A-Z0-9.\-]{1,10}$/i.test(tickerRaw) ? tickerRaw.toUpperCase() : null;
      const c5 = t(row, 5);
      const c6 = t(row, 6);
      const c7 = t(row, 7);
      const token = c5 && !isUrl(c5) && /100$/i.test(c5) ? c5 : null;
      const website = [c5, c6].find((x) => x && isUrl(x) && x !== c7) ?? null;
      const prEmail = extractEmails(c(row, 8))[0] ?? null;
      const exclude = new Set<string>(prEmail ? [prEmail] : []);
      const rel = parseRelationshipCell(t(row, 9));
      if (rel?.email) exclude.add(rel.email);
      const contacts = [...(rel ? [rel] : []), ...contactsFromCells(row, 10, 33, exclude)];
      const linkedin = row.map((x) => cellText(x)).find((x) => isLinkedinUrl(x)) ?? null;
      if (linkedin && contacts[0] && !contacts[0].linkedinUrl) contacts[0].linkedinUrl = linkedin;
      let marketCap: number | null = null;
      for (let col = 20; col <= 33 && marketCap == null; col++) {
        const v = t(row, col);
        if (v && /^\$\s?[\d.,]+\s*[KMBT]$/i.test(v)) marketCap = parseMarketCapUsd(v.replace(/T$/i, "000B"));
      }
      const status2 = t(row, 17);
      const outreach = t(row, 18);
      const { stageKey, lastContactedAt, notes } = r100Stage(c(row, 10), status2, outreach);
      const c8 = t(row, 8);
      if (c8 && !prEmail && !isUrl(c8)) notes.push(`PR contact: ${c8}`);
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.domain": stripCorporateSubdomain(normalizeDomain(website)),
          "account.ticker": ticker,
          "account.tokenName": token,
          "account.isB2c": c(row, 3),
          "account.pressPage": c7 && isUrl(c7) ? c7 : null,
          "account.prEmail": prEmail,
          "deal.owner": c(row, 2),
          "deal.notes": notes,
        },
        i + 1,
        ctx("R100", "RTB 100 MASTER", { accountType: website && CRYPTO_TLD.test(website) ? "token_project" : "public_company" }),
      );
      if (rec) {
        rec.contacts = contacts;
        rec.account.marketCapUsd = marketCap;
        if (t(row, 19) === "Like") rec.account.customFields = { r100Like: true };
        if (rec.deal) {
          if (stageKey) {
            rec.deal.stageKey = stageKey;
            rec.deal.lastContactedAt = lastContactedAt;
          } else {
            rec.deal = null; // untouched universe row → account + contacts only
            accountsOnly++;
          }
        }
      }
      applyRec(rec, "RTB 100 MASTER", i + 1, cnt);
    }
    finishSheet(file, "RTB 100 MASTER", sh.rows.length - 1, cnt);
    report.notes.push(`RTB 100 MASTER: ${accountsOnly} rows had no status / outreach evidence → imported as target accounts (with contacts) but no R100 deal; rows with a status, a date, “Relationship already” or “outreach sent” became R100 deals.`);
  }

  // 4f. RTB 100 Editorial Outreach (section headers → category; Bonus → r100.bonusCents)
  {
    const sh = sheetOf(wb, "RTB 100 Editorial Outreach");
    const cnt = counter();
    let section: string | null = null;
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      if (isBlank(row)) continue;
      const label = sectionLabel(row);
      if (label) {
        section = label;
        continue;
      }
      const name = t(row, 1);
      if (!name || name.length > 120) continue;
      const ownerCell = c(row, 2);
      const ownerText = ownerCell instanceof Date ? null : cellText(ownerCell);
      const category = t(row, 3) ?? section;
      const prEmail = extractEmails(c(row, 8))[0] ?? null;
      const contacts = contactsFromCells(row, 9, 15, new Set(prEmail ? [prEmail] : []));
      const { stageKey, lastContactedAt, notes } = r100Stage(c(row, 9), t(row, 16), null);
      const paren = ownerText?.match(/\((.+)\)/)?.[1];
      if (paren) notes.push(`Owner note: ${paren}`);
      const t10 = t(row, 10);
      if (t10 && !extractEmails(t10).length && t10.length > 3) notes.push(t10);
      const website = t(row, 6);
      const rec = normalizeFields(
        {
          "account.name": name,
          "account.domain": website && isUrl(website) ? stripCorporateSubdomain(normalizeDomain(website)) : null,
          "account.category": category,
          "account.ticker": c(row, 4),
          "account.tokenName": c(row, 5),
          "account.pressPage": c(row, 7),
          "account.prEmail": prEmail,
          "deal.owner": ownerText,
          "deal.notes": notes,
          "r100.bonus": c(row, 17),
        },
        i + 1,
        ctx("R100", "RTB 100 Editorial Outreach", { accountType: category && /crypto/i.test(category) ? "token_project" : "public_company" }),
      );
      if (rec) {
        rec.contacts = contacts;
        if (rec.deal) {
          rec.deal.stageKey = stageKey ?? "target";
          rec.deal.lastContactedAt = lastContactedAt;
          rec.deal.customFields = { editorialCategory: category };
          if (!rec.deal.owners.length && !stageKey && !rec.deal.r100?.bonusCents) rec.deal = null;
        }
      }
      applyRec(rec, "RTB 100 Editorial Outreach", i + 1, cnt);
    }
    finishSheet(file, "RTB 100 Editorial Outreach", sh.rows.length - 1, cnt);
  }

  // 4g. RTB100 Interviews → deal.customFields.interviews
  {
    const sh = sheetOf(wb, "RTB100 Interviews");
    const ALIAS: Record<string, string> = { hive: "HIVE Digital Technologies", near: "NEAR Protocol", ondo: "Ondo Finance", "rootinsurance": "Root", "kratosdefense": "Kratos Defense & Security Solutions", bitgo: "Bitgo" };
    const byDeal = new Map<string, { deal: NonNullable<ReturnType<typeof engine.findDeal>>; items: Record<string, unknown>[] }>();
    let matched = 0;
    for (let i = 1; i < sh.rows.length; i++) {
      const row = sh.rows[i]!;
      const company = t(row, 1);
      if (!company) continue;
      const alias = ALIAS[normalizeName(company)];
      const deal = (alias ? engine.findDeal(alias, "R100") : null) ?? engine.findDeal(company, "R100") ?? engine.findDealsByLooseName(company, "R100")[0] ?? null;
      const dateCell = c(row, 4);
      const filmed = dateCell instanceof Date ? dateCell : parseLooseDate(dateCell);
      const statusText = cellText(dateCell)?.toLowerCase() ?? "";
      const item = {
        guest: t(row, 2),
        host: t(row, 3),
        status: filmed || statusText === "filmed" ? "filmed" : statusText === "rescheduling" ? "rescheduling" : "scheduled",
        filmedDate: filmed ? filmed.toISOString().slice(0, 10) : null,
        publishDate: parseLooseDate(c(row, 5))?.toISOString().slice(0, 10) ?? null,
        publishRaw: t(row, 5),
      };
      if (!deal) {
        report.unmatched.push({ sheet: "RTB100 Interviews", name: `${company} (${item.guest ?? "?"})`, reason: "no matching R100 deal" });
        continue;
      }
      matched++;
      const e = byDeal.get(deal.id) ?? { deal, items: [] };
      e.items.push(item);
      byDeal.set(deal.id, e);
    }
    for (const { deal, items } of byDeal.values()) engine.patchDealCustomFields(deal, { interviews: items });
    console.log(`  · RTB100 Interviews: ${matched} matched to R100 deals`);
    report.sheetRows.push({ file, sheet: "RTB100 Interviews", rows: sh.rows.length - 1, records: matched, deals: byDeal.size, skipped: sh.rows.length - 1 - matched });
  }

  await flush(file);
}

/* ═════════════════════════ reconciliation report ═════════════════════════ */

async function buildReport(db: ReturnType<typeof scriptDb>["db"]) {
  const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
  const usd = (cents: number | null | undefined) => (cents == null ? "—" : `$${fmt(cents / 100)}`);
  const L: string[] = [];
  L.push(`# Import reconciliation report`, "");
  L.push(`Generated ${IMPORT_DATE.toISOString()} by \`scripts/import-spreadsheets.ts\`${DRY ? " (verification **dry run** against the imported database — nothing written by this run)" : ""}.`, "");
  const statRow = (file: string, id: string, status: string, st: Partial<BatchStats>) =>
    `| ${file} | \`${id.slice(0, 8)}\` | ${status} | ${st.rows ?? 0} | ${st.accountsCreated ?? 0}/${st.accountsUpdated ?? 0} | ${st.dealsCreated ?? 0}/${st.dealsUpdated ?? 0} | ${st.contactsCreated ?? 0}/${st.contactsUpdated ?? 0} | ${st.activitiesCreated ?? 0} | ${st.metricsCreated ?? 0} | ${st.splitsCreated ?? 0} | ${st.duplicatesMerged ?? 0} | ${st.migrationsCreated ?? 0} | ${st.placeholdersCreated ?? 0} | ${st.unmappedStatuses ?? 0} | ${st.skipped ?? 0} |`;
  const head = ["| File | Batch | Status | Rows | Accounts +/~ | Deals +/~ | Contacts +/~ | Notes | Metrics | Splits | Dupes merged | Migrations | Placeholders | Unmapped | Skipped |", "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const dbBatches = await db.select().from(s.importBatches).where(sql`${s.importBatches.mapping}->>'note' is not null`).orderBy(s.importBatches.createdAt);
  L.push("## Import batches in the database (one per source file; roll back from /import/history)", "", ...head);
  for (const b of dbBatches) L.push(statRow(b.fileName, b.id, b.status, b.stats as Partial<BatchStats>));
  L.push("", "_+ = created, ~ = updated (existing record, empty fields filled / stage advanced). “Dupes merged” = rows that collapsed into a record created earlier in the same batch._", "");
  for (const b of dbBatches.filter((x) => x.status === "failed"))
    L.push(
      `> **Batch \`${b.id.slice(0, 8)}\` (${b.fileName}) failed** during its first flush (a same-name account claimed a domain another row already owned — fixed in the engine). Its inserts were kept and adopted by the next, completed run of the same file (which only filled gaps). Because the failed batch never wrote its import_records, its ${(b.stats as Partial<BatchStats>).accountsCreated ?? "?"} accounts / ${(b.stats as Partial<BatchStats>).dealsCreated ?? "?"} deals are **not** covered by one-click rollback; they can be attached to that batch with an INSERT … SELECT on created_at (see final report of the import agent).`,
      "",
    );
  L.push("Later batches of the same file are idempotent re-runs after matching fixes; “Duplicate repair (post-import)” batches merged same-name duplicates and moved mis-attached R100/ADS deals (all reversible):", "");
  for (const b of dbBatches.filter((x) => x.fileName.startsWith("Duplicate repair"))) L.push(`- \`${b.id.slice(0, 8)}\` ${Object.entries((b.stats ?? {}) as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push("");
  if (DRY) {
    L.push("## Re-run check (this dry run)", "", "Idempotency: re-running the migration against the imported database should create nothing new.", "", ...head);
    for (const b of report.batches) L.push(statRow(b.file, b.batchId, "dry run", b.stats));
    L.push("");
  }
  L.push("## Rows by sheet", "", "| File | Sheet | Source rows | Records | With deal | Skipped |", "|---|---|---:|---:|---:|---:|");
  for (const r of report.sheetRows) L.push(`| ${r.file.slice(0, 40)} | ${r.sheet} | ${r.rows} | ${r.records} | ${r.deals} | ${r.skipped} |`);
  L.push("");

  {
    const byStage = await db.execute(sql`
      select p.key as pipeline, st.name as stage, st.sort_order as so, count(d.id)::int as n,
             coalesce(sum(d.muu),0)::bigint as muu, coalesce(sum(coalesce(d.annualized_value_cents, d.contract_value_cents)),0)::bigint as cents
      from rso.deals d join rso.pipelines p on p.id = d.pipeline_id join rso.stages st on st.id = d.stage_id
      where d.deleted_at is null group by p.key, p.sort_order, st.name, st.sort_order order by p.sort_order, st.sort_order`);
    L.push("## Deals by pipeline / stage (database after import)", "", "| Pipeline | Stage | Deals | MUU | $ (annualized/contract) |", "|---|---|---:|---:|---:|");
    for (const r of byStage as unknown as { pipeline: string; stage: string; n: number; muu: string; cents: string }[])
      L.push(`| ${r.pipeline} | ${r.stage} | ${r.n} | ${fmt(Number(r.muu))} | ${Number(r.cents) ? usd(Number(r.cents)) : "—"} |`);
    const byOwner = await db.execute(sql`
      select coalesce(u.name, '(unassigned)') as owner, p.key as pipeline, count(*)::int as n
      from rso.deals d join rso.pipelines p on p.id = d.pipeline_id left join rso."user" u on u.id = d.owner_id
      where d.deleted_at is null group by 1, 2 order by 1, 2`);
    L.push("", "## Deals by owner (primary owner; splits in deal_splits)", "", "| Owner | Pipeline | Deals |", "|---|---|---:|");
    for (const r of byOwner as unknown as { owner: string; pipeline: string; n: number }[]) L.push(`| ${r.owner} | ${r.pipeline} | ${r.n} |`);
    const [totals] = (await db.execute(sql`
      select (select count(*) from rso.accounts where deleted_at is null)::int as accounts,
             (select count(*) from rso.accounts where deleted_at is null and lifecycle = 'disqualified')::int as disqualified,
             (select count(*) from rso.accounts where deleted_at is null and restricted)::int as restricted_accounts,
             (select count(*) from rso.contacts where deleted_at is null)::int as contacts,
             (select count(*) from rso.deals where deleted_at is null)::int as deals,
             (select count(*) from rso.deals where deleted_at is null and override_status = 'pending')::int as overrides_pending,
             (select count(*) from rso.deal_splits)::int as splits,
             (select count(*) from rso.activities where source = 'import')::int as notes,
             (select count(*) from rso.audience_metrics)::int as metrics,
             (select count(*) from rso.migration_projects)::int as migrations,
             (select count(*) from (select domain from rso.accounts where deleted_at is null and domain is not null group by domain having count(*) > 1) x)::int as dup_domains,
             (select count(*) from rso."user" where email like '%.placeholder@roundtable.invalid')::int as placeholders`)) as unknown as Record<string, number>[];
    L.push("", "## Totals", "");
    for (const [k, v] of Object.entries(totals ?? {})) L.push(`- **${k.replace(/_/g, " ")}**: ${fmt(Number(v))}`);

    // C&W Summary comparison
    const ads = (await db.execute(sql`
      select st.key as stage, count(*)::int as n, coalesce(sum(d.contract_value_cents),0)::bigint as contract,
             coalesce(sum(d.annualized_value_cents),0)::bigint as annual, coalesce(sum(d.next_payment_cents),0)::bigint as nextpay,
             bool_or('active_deal' = any(d.tags)) as active
      from rso.deals d join rso.pipelines p on p.id = d.pipeline_id and p.key = 'ADS' join rso.stages st on st.id = d.stage_id
      where d.deleted_at is null and 'imported' = any(d.tags) group by st.key`)) as unknown as { stage: string; n: number; contract: string; annual: string; nextpay: string }[];
    const adsBy = (keys: string[]) => ads.filter((r) => keys.includes(r.stage)).reduce((a, r) => ({ n: a.n + r.n, contract: a.contract + Number(r.contract), annual: a.annual + Number(r.annual), nextpay: a.nextpay + Number(r.nextpay) }), { n: 0, contract: 0, annual: 0, nextpay: 0 });
    const net = (await db.execute(sql`
      select (case when p.key = 'ENT' then (case st.key when 'negotiation' then 'hot' when 'proposal' then 'demo' when 'won' then 'migrating' when 'nda' then 'in_comms' else st.key end) else st.key end) as stage,
             count(*)::int as n, coalesce(sum(d.muu),0)::bigint as muu
      from rso.deals d join rso.pipelines p on p.id = d.pipeline_id join rso.stages st on st.id = d.stage_id
      where d.deleted_at is null and 'cw_netdev' = any(d.tags) group by 1`)) as unknown as { stage: string; n: number; muu: string }[];
    const netBy = (keys: string[]) => net.filter((r) => keys.includes(r.stage)).reduce((a, r) => ({ n: a.n + r.n, muu: a.muu + Number(r.muu) }), { n: 0, muu: 0 });
    const r100 = (await db.execute(sql`
      select st.key as stage, count(*)::int as n from rso.deals d join rso.pipelines p on p.id = d.pipeline_id and p.key = 'R100'
      join rso.stages st on st.id = d.stage_id where d.deleted_at is null and 'imported' = any(d.tags) group by st.key`)) as unknown as { stage: string; n: number }[];
    const r100By = (keys: string[]) => r100.filter((r) => keys.includes(r.stage)).reduce((a, r) => a + r.n, 0);
    const target = (label: RegExp) => report.summaryTargets.find((x) => label.test(x.label));
    const row = (label: string, tgt: ReturnType<typeof target>, n: number, v: string, valueFmt: (x: number | null) => string) =>
      `| ${label} | ${tgt?.count ?? "—"} | ${n} | ${tgt?.value != null ? valueFmt(tgt.value) : "—"} | ${v} |`;
    L.push("", "## Validation vs Chris & Will “Summary” tab (AT-10)", "", "| Metric | Summary count | CRM count | Summary value | CRM value |", "|---|---:|---:|---:|---:|");
    const act = adsBy(["negotiation", "verbal", "loi"]);
    const cur = adsBy(["current_client"]);
    const warm = adsBy(["warm"]);
    const $ = (x: number | null) => (x == null ? "—" : `$${fmt(x)}`);
    const m = (x: number | null) => fmt(x);
    L.push(row("TheStreet — active deals closing", target(/active deals closing/i), act.n, usd(act.contract), $));
    L.push(row("TheStreet — current client annualized", target(/current client annualized/i), cur.n, usd(cur.annual), $));
    L.push(row("TheStreet — upcoming current-client collections", target(/upcoming current client collections/i), cur.n, usd(cur.nextpay), $));
    L.push(row("TheStreet — warm deals in negotiation", target(/warm deals in negotiation/i), warm.n, usd(warm.annual), $));
    const mig = netBy(["migrating"]);
    const hot = netBy(["in_comms", "hot", "demo", "contract"]);
    const warming = netBy(["warming"]);
    const hold = netBy(["on_hold"]);
    const tot = netBy(net.map((r) => r.stage));
    L.push(row("NetDev (C&W rows) — migrating", target(/migrating/i), mig.n, fmt(mig.muu), m));
    L.push(row("NetDev (C&W rows) — call set / hot (+demo/contract)", target(/call set/i), hot.n, fmt(hot.muu), m));
    L.push(row("NetDev (C&W rows) — warming up", target(/^warming up$/i), warming.n, fmt(warming.muu), m));
    L.push(row("NetDev (C&W rows) — on hold", target(/on hold/i), hold.n, fmt(hold.muu), m));
    L.push(row("NetDev (C&W rows) — total", target(/total pipeline/i), tot.n, fmt(tot.muu), m));
    const live = r100By(["profile_activated", "first_post"]);
    L.push(row("RTB100 — live accounts", target(/live accounts/i), live, "—", m));
    L.push(row("RTB100 — made first post", target(/made first post/i), r100By(["first_post"]), "—", m));
    L.push(row("RTB100 — profile activated", target(/profile activated/i), r100By(["profile_activated"]), "—", m));
    L.push(row("RTB100 — hot", target(/^hot$/i), r100By(["hot"]), "—", m));
    L.push(row("RTB100 — warming up", report.summaryTargets.filter((x) => /^warming up$/i.test(x.label))[1] ?? target(/^warming up$/i), r100By(["warming"]), "—", m));
    L.push(row("RTB100 — cold, keep comms", target(/cold/i), r100By(["cold"]), "—", m));
    L.push("", "**Reconciling items**", "");
    L.push("- CRM stages are the *most advanced* status across every source (e.g. a C&W “On Hold” publisher that the DRAFT/v7 or RTB Sites tabs show as “Hot” lands in Hot), so bucket counts can move between rows while the C&W row total stays equal.");
    L.push("- NetDev MUU sums use each deal's MUU, which is filled from the highest-priority source first (Strategic > Active > Pipeline); C&W 8/19 figures only fill gaps.");
    L.push("- RTB100 counts cover every R100 deal (C&W + v7 activation tracker + RTB Sites MASTER/Editorial), not just the C&W tab; extra live accounts come from the activation tracker and MASTER sheet.");
  }

  L.push("", "## Unmapped status values", "");
  const unm = new Map<string, number>();
  for (const b of report.batches) for (const [k, v] of Object.entries(b.unmapped)) unm.set(k, (unm.get(k) ?? 0) + v);
  if (unm.size === 0) L.push("_None — every status cell mapped to a stage or was classified as a date / email / URL / note._");
  else for (const [k, v] of [...unm.entries()].sort((a, b) => b[1] - a[1])) L.push(`- “${k}” × ${v} → first stage, raw value kept in customFields.importedStatus + note`);
  L.push("", "## Non-status values found in status columns (routed to notes / last contacted)", "");
  for (const [k, v] of [...report.statusNotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) L.push(`- ${k} × ${v}`);
  L.push("", "## Unmatched / special rows", "");
  if (!report.unmatched.length) L.push("_None._");
  for (const u of report.unmatched) L.push(`- **${u.sheet}** — ${u.name}: ${u.reason}`);
  L.push("", `## Skipped rows (${report.skipped.length})`, "");
  const skipBySheet = new Map<string, number>();
  for (const sk of report.skipped) skipBySheet.set(`${sk.sheet}: ${sk.reason}`, (skipBySheet.get(`${sk.sheet}: ${sk.reason}`) ?? 0) + 1);
  for (const [k, v] of skipBySheet) L.push(`- ${k} × ${v}`);
  L.push("", "## Team tab vs placeholder users", "", "| Person | Team tab | Placeholder employment type |", "|---|---|---|");
  for (const tm of report.teamCheck) L.push(`| ${tm.name} | ${tm.sheet} | ${tm.seeded} |`);
  L.push("", `Placeholder users are \`<first>.placeholder@roundtable.invalid\`, role viewer, banned (cannot sign in). Claim them with \`claimPlaceholder()\` (src/lib/accounts/placeholders.ts) once the real user signs in. Example: ${placeholderEmail("Kevin")}.`);
  L.push("", "## Notes & decisions", "");
  for (const n of report.notes) L.push(`- ${n}`);
  L.push("- Pipeline routing: Arena Group (Paradium.AI) → ENT **restricted**; the PRD's named enterprise groups (NY Post, Reach plc, Baltimore Sun, Sinclair, GB News, HT Media) and any Strategic / Active / Closed row with ≥ 10M MUU (D7) → ENT; Sports rows → SPT; everything else → NET. The same account keeps the same pipeline across tabs (C&W NetDev rows that are ENT in v7 merge into the ENT deal and are counted in the NetDev validation rows above).");
  L.push("- NetDev “Monthly visits” (CLEANED, Spanish, NETDEV Pipeline, and v7 rows sourced from “NetDev Pipeline”) are stored as audience metric **visits**; MUU is derived as visits ÷ 2.5 and flagged *estimate*. Blue MUU cells in v7 are stored as “BFF research estimate”.");
  L.push("- Every imported deal: tag `imported`, next step from the sheet or “Review imported deal”, due import date + 7 days, source = sheet name.");
  L.push("- Removed (off model) accounts are lifecycle *disqualified* (reason in notes/customFields) and do not get early-stage deals from other list tabs.");
  return L.join("\n") + "\n";
}

/* ═════════════════════════ repair pass (--repair) ═════════════════════════ */

/**
 * Collapses duplicates left by an interrupted run / name-only matches, reversibly (own import batch):
 *  A. same normalized name, one account with a domain + others without (same side of company/media) → merge;
 *  B. R100/ADS deals sitting on a publisher that merely shares a company's name → move to the company account;
 *  C. two live deals of one account in one pipeline → keep the most advanced, fold the other in.
 */
async function repairDuplicates(db: ReturnType<typeof scriptDb>["db"]) {
  console.log("\n▶ Duplicate repair");
  const batchId = crypto.randomUUID();
  const recs: { entity: string; entityId: string; action: "updated" | "created" | "merged"; before: unknown }[] = [];
  const stats = { accountsMerged: 0, dealsMoved: 0, dealsMerged: 0, fieldsCleared: 0 };
  if (!DRY)
    await db.insert(s.importBatches).values({ id: batchId, fileName: "Duplicate repair (post-import)", sheetName: null, target: "accounts", status: "running", mapping: { note: "scripts/import-spreadsheets.ts --repair" }, stats: {} });
  const accs = await db
    .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, type: s.accounts.type, createdAt: s.accounts.createdAt })
    .from(s.accounts)
    .where(and(isNull(s.accounts.deletedAt), sql`${s.accounts.source} is not null`));
  const logMerge = (res: Awaited<ReturnType<typeof mergeAccounts>>, targetId: string, sourceId: string) => {
    recs.push({ entity: "account", entityId: targetId, action: "updated", before: res.targetBefore });
    recs.push({ entity: "account", entityId: sourceId, action: "merged", before: res.sourceBefore });
    for (const [entity, ids] of Object.entries(res.moved)) for (const id of ids) recs.push({ entity, entityId: id, action: "updated", before: { accountId: sourceId } });
  };

  // A. same-name duplicates
  const byName = new Map<string, typeof accs>();
  for (const a of accs) {
    const n = normalizeName(a.name);
    if (n) byName.set(n, [...(byName.get(n) ?? []), a]);
  }
  /** Merge a group that is one entity: same root domain (ir./news. subdomains collapse) or no domain at all. */
  const mergeGroup = async (group: typeof accs): Promise<boolean> => {
    const roots = new Set(group.filter((a) => a.domain).map((a) => stripCorporateSubdomain(a.domain)));
    if (group.length < 2 || roots.size > 1) return false;
    const root = [...roots][0] ?? null;
    const ordered = [...group].sort((a, b) => Number(b.domain === root && !!root) - Number(a.domain === root && !!root) || Number(!!b.domain) - Number(!!a.domain) || a.createdAt.getTime() - b.createdAt.getTime());
    const survivor = ordered[0]!;
    // the domain *is* the name (crowdstrike.com ↔ “CrowdStrike”): same entity even across company/publisher types
    for (const dup of ordered.slice(1)) {
      if (!typesCompatible(dup.type, survivor.type) && !(!dup.domain && domainIsName(survivor.domain, dup.name))) continue;
      console.log(`  merge “${dup.name}” (${dup.domain ?? "no domain"}) → “${survivor.name}” (${survivor.domain ?? "no domain"})`);
      if (!DRY) logMerge(await mergeAccounts(db, { targetId: survivor.id, sourceId: dup.id }), survivor.id, dup.id);
      stats.accountsMerged++;
    }
    return true;
  };
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    if (await mergeGroup(group)) continue;
    // different root domains under one normalized name ("Solana" vs "Solana Company"): only exact-name twins merge
    const exact = new Map<string, typeof accs>();
    for (const a of group) exact.set(a.name.trim().toLowerCase(), [...(exact.get(a.name.trim().toLowerCase()) ?? []), a]);
    for (const sub of exact.values()) await mergeGroup(sub);
  }

  // B. company-program deals attached to a same-name publisher
  const misplaced = (await db.execute(sql`
    select d.id as deal_id, d.pipeline_id, a.id as media_id, a.name, a.ticker, c.id as company_id, c.ticker as company_ticker
    from rso.deals d
    join rso.pipelines p on p.id = d.pipeline_id and p.key in ('R100', 'ADS')
    join rso.accounts a on a.id = d.account_id and a.type in ('publisher', 'media_group') and a.deleted_at is null
    join rso.accounts c on c.deleted_at is null and c.id <> a.id and c.type in ('public_company', 'token_project') and c.domain is not null and c.domain <> coalesce(a.domain, '')
      and lower(regexp_replace(regexp_replace(c.name, '^the ', '', 'i'), '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(regexp_replace(a.name, '^the ', '', 'i'), '[^a-zA-Z0-9]', '', 'g'))
    where d.deleted_at is null and 'imported' = any(d.tags)`)) as unknown as { deal_id: string; media_id: string; name: string; ticker: string | null; company_id: string; company_ticker: string | null }[];
  for (const m of misplaced) {
    console.log(`  move ${m.name} program deal → company account`);
    if (!DRY) {
      await db.update(s.deals).set({ accountId: m.company_id }).where(eq(s.deals.id, m.deal_id));
      await db.update(s.activities).set({ accountId: m.company_id }).where(eq(s.activities.dealId, m.deal_id));
      recs.push({ entity: "deal", entityId: m.deal_id, action: "updated", before: { accountId: m.media_id } });
      if (m.ticker && (m.ticker === m.company_ticker || !m.company_ticker)) {
        const [media] = await db.select().from(s.accounts).where(eq(s.accounts.id, m.media_id));
        if (media) {
          const before = { ticker: media.ticker, tokenName: media.tokenName, isB2c: media.isB2c, marketCapUsd: media.marketCapUsd, pressPage: media.pressPage, prEmail: media.prEmail };
          await db.update(s.accounts).set({ ticker: null, tokenName: null, isB2c: null, marketCapUsd: null, pressPage: null, prEmail: null }).where(eq(s.accounts.id, m.media_id));
          recs.push({ entity: "account", entityId: m.media_id, action: "updated", before });
          stats.fieldsCleared++;
        }
      }
    }
    stats.dealsMoved++;
  }

  // C. duplicate deals per account + pipeline
  const stageRows = await db.select().from(s.stages);
  const stageById = new Map(stageRows.map((x) => [x.id, x]));
  const dupDeals = (await db.execute(sql`
    select d.account_id, d.pipeline_id, array_agg(d.id::text order by d.created_at) as ids
    from rso.deals d where d.deleted_at is null and d.account_id is not null and 'imported' = any(d.tags)
    group by 1, 2 having count(*) > 1`)) as unknown as { account_id: string; pipeline_id: string; ids: string[] }[];
  for (const g of dupDeals) {
    const deals = await db.select({ id: s.deals.id, stageId: s.deals.stageId }).from(s.deals).where(inArray(s.deals.id, g.ids));
    const rank = (id: string) => {
      const st = stageById.get(deals.find((x) => x.id === id)!.stageId);
      return st ? stageRank(st) : 0;
    };
    const keep = [...g.ids].sort((a, b) => rank(b) - rank(a))[0]!;
    for (const drop of g.ids.filter((x) => x !== keep)) {
      if (!DRY) {
        const res = await mergeDeals(db, { keepId: keep, dropId: drop });
        recs.push({ entity: "deal", entityId: keep, action: "updated", before: res.keepBefore });
        recs.push({ entity: "deal", entityId: drop, action: "merged", before: res.dropBefore });
        for (const [entity, ids] of Object.entries(res.moved)) for (const id of ids) recs.push({ entity, entityId: id, action: "updated", before: { dealId: drop } });
        for (const cid of res.addedContacts) recs.push({ entity: "deal_contact", entityId: keep, action: "created", before: { contactId: cid } });
        for (const uid of res.copiedSplits) recs.push({ entity: "deal_split", entityId: keep, action: "created", before: { userId: uid } });
      }
      stats.dealsMerged++;
    }
  }

  console.log(`  ${JSON.stringify(stats)}`);
  report.notes.push(`${DRY ? "Re-run check (dry) — duplicate repair would change: " : "Duplicate repair pass: "}${stats.accountsMerged} same-name accounts merged, ${stats.dealsMoved} R100/ADS deals moved off same-name publishers, ${stats.dealsMerged} duplicate deals folded (batch “Duplicate repair (post-import)”, reversible).`);
  if (DRY) return;
  for (let i = 0; i < recs.length; i += 1000)
    await db.insert(s.importRecords).values(recs.slice(i, i + 1000).map((r) => ({ batchId, entity: r.entity, entityId: r.entityId, action: r.action, before: (r.before ?? null) as never })));
  await db.update(s.importBatches).set({ status: "completed", stats: stats as unknown as Record<string, number> }).where(eq(s.importBatches.id, batchId));
  await db.insert(s.auditLog).values({ actorId: null, actorKind: "system", action: "import.repair", entity: "import_batch", entityId: batchId, after: stats as never });
}

/* ═════════════════════════ main ═════════════════════════ */

async function main() {
  const { db, close } = scriptDb();
  try {
    engine = new ImportEngine(db, { actorId: null, importDate: IMPORT_DATE });
    await engine.load();
    for (const k of ["NET", "ENT", "SPT", "R100", "ADS"]) if (!engine.stagesFor(k).length) throw new Error(`Pipeline ${k} has no stages — run scripts/seed.ts first`);
    await loadDraft();
    const v7wb = await readXlsxFile(FILES.v7, { withColors: true });
    prepareV7Keys(sheetOf(v7wb, "Pipeline Master"));
    if (ONLY.includes("v7")) await importV7(v7wb);
    // keys of v7 "Removed" rows, to keep them out of the DRAFT extras batch
    const removed = sheetOf(v7wb, "Removed (off model)");
    const removedKeys = new Set<string>();
    for (let i = 1; i < removed.rows.length; i++) for (const k of keysOf(t(removed.rows[i]!, 1), t(removed.rows[i]!, 2))) removedKeys.add(k);
    if (ONLY.includes("draft")) await importDraftExtras(removedKeys);
    if (ONLY.includes("cw")) await importCW();
    if (ONLY.includes("sites")) await importSites();
    if (process.argv.includes("--repair")) await repairDuplicates(db);
    const md = await buildReport(db);
    writeFileSync("docs/IMPORT_REPORT.md", md);
    console.log(`\nReport written to docs/IMPORT_REPORT.md`);
    if (!DRY) {
      const [chk] = (await db.execute(sql`select count(*)::int as n from (select domain from rso.accounts where deleted_at is null and domain is not null group by domain having count(*) > 1) x`)) as unknown as { n: number }[];
      console.log(`Duplicate domains after import: ${chk?.n ?? "?"}`);
      const [open] = await db.select({ n: sql<number>`count(*)::int` }).from(s.deals).where(and(isNull(s.deals.deletedAt), eq(s.deals.status, "open"), isNull(s.deals.nextStep)));
      console.log(`Open deals without next step: ${open?.n ?? "?"}`);
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("IMPORT FAILED:", e);
  process.exit(1);
});
