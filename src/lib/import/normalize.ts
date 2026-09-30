/**
 * Row normalization: mapped spreadsheet cells → a NormalizedRecord (account + optional deal + contacts + notes +
 * audience metrics) that the ImportEngine commits. Pure — shared by the wizard and scripts/import-spreadsheets.ts.
 */
import { nameFromEmail } from "../contacts/seniority";
import { normalizeDomain, parseAudience } from "../domain";
import {
  cellText,
  cellToValue,
  extractEmails,
  isLinkedinUrl,
  isUrl,
  parseBool,
  parseLooseDate,
  parseMarketCapUsd,
  parseMoneyToCents,
  parseProbability,
  type CellValue,
} from "./cells";
import { cleanAccountName } from "./dedupe";
import { columnIds, type ImportTarget, type Mapping } from "./fields";
import { parseOwners } from "./owners";
import { tierToStageKey, type StatusMatch } from "./status";

export type Confidence = "verified" | "reported" | "estimate";
export type AccountType = "publisher" | "media_group" | "public_company" | "token_project" | "advertiser" | "agency" | "partner" | "other";
export type Priority = "top10" | "high" | "medium" | "low";

export type R100Data = {
  firstPostDate?: string | null;
  participation?: boolean[];
  postCount?: number;
  profileUrl?: string | null;
  editorialLinks?: string[];
  bonusEligible?: boolean;
  bonusCents?: number;
};

export type NormalizedContact = {
  fullName: string;
  email: string | null;
  altEmails?: string[];
  title?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  relationshipOwner?: string | null; // rep first name ("Will POC")
  notes?: string | null;
};

export type NormalizedActivity = { type: "note" | "meeting"; subject: string; body: string; occurredAt?: Date | null };

export type NormalizedRecord = {
  rowNumber: number;
  source: string; // sheet / file label
  account: {
    name: string;
    domain: string | null;
    altDomains?: string[];
    type?: AccountType;
    category?: string | null;
    subcategory?: string | null;
    league?: string | null;
    team?: string | null;
    country?: string | null;
    region?: string | null;
    language?: string | null;
    ownership?: string | null;
    ticker?: string | null;
    tokenName?: string | null;
    isB2c?: boolean | null;
    marketCapUsd?: number | null;
    website?: string | null;
    pressPage?: string | null;
    prEmail?: string | null;
    linkedinUrl?: string | null;
    priority?: Priority | null;
    restricted?: boolean;
    lifecycle?: "target" | "prospect" | "customer" | "churned" | "disqualified";
    notes?: string | null;
    customFields?: Record<string, unknown>;
  };
  audience: { metric: "muu" | "visits"; value: number; rawValue: string; source: string; confidence: Confidence; derivedMuu?: number | null; factorUsed?: number | null }[];
  deal: null | {
    pipelineKey: string;
    stageKey: string | null; // null → pipeline's first stage
    statusRaw?: string | null;
    owners: string[];
    priority?: Priority | null;
    nextStep?: string | null;
    muu?: number | null;
    probabilityOverride?: number | null;
    overrideReason?: string | null;
    overrideStatus?: "pending" | "approved" | null;
    contractValueCents?: number | null;
    annualizedValueCents?: number | null;
    nextPaymentCents?: number | null;
    r100?: R100Data;
    customFields?: Record<string, unknown>;
    restricted?: boolean;
    lastContactedAt?: Date | null;
    lostReason?: string | null;
    tags?: string[];
    name?: string;
  };
  contacts: NormalizedContact[];
  activities: NormalizedActivity[];
  issues: { level: "error" | "warning"; field: string; message: string }[];
  /** Classified non-status values from the status column (for the reconciliation report). */
  statusNote?: { kind: string; raw: string } | null;
};

export function parsePriority(v: unknown): Priority | null {
  const s = cellText(v)?.toLowerCase();
  if (!s) return null;
  if (/\btop\b/.test(s)) return "top10";
  if (/^2\b|\bhigh\b/.test(s)) return "high";
  if (/^1\b|\bmedium\b|\bmed\b/.test(s)) return "medium";
  if (/^0\b|\blow\b/.test(s)) return "low";
  return null;
}

/** "Frank Holmes (Exec Chairman) - Will POC" / "Gerard Dwyer, CIO - gdwyer@rivian.com" → contact. */
export function parseRelationshipCell(raw: string | null | undefined): NormalizedContact | null {
  const s = raw?.trim();
  if (!s || s.length > 200) return null;
  const emails = extractEmails(s);
  const pocMatch = s.match(/\b([A-Z][a-z]+)(?:\/[A-Z][a-z]+)?\s+poc\b/i);
  const relationshipOwner = pocMatch ? parseOwners(pocMatch[1])[0] ?? null : null;
  let head = s.split(/\s[-–—]\s/)[0]!.trim();
  let title: string | null = null;
  const paren = head.match(/\((.+?)\)/);
  if (paren) {
    title = paren[1]!.trim();
    head = head.replace(paren[0], "").trim();
  }
  const comma = head.split(",");
  if (comma.length > 1) {
    title = title ?? comma.slice(1).join(",").trim();
    head = comma[0]!.trim();
  }
  head = head.replace(/[\w.+-]+@[\w.-]+/g, "").trim();
  if (!head || /^(on|chris|will|chris\/will)$/i.test(head) || head.split(/\s+/).length > 4) {
    if (!emails.length) return null;
    head = nameFromEmail(emails[0]!);
  }
  return { fullName: head, email: emails[0] ?? null, title, relationshipOwner };
}

export type NormalizeContext = {
  target: ImportTarget;
  pipelineKey: string; // NET/ENT/SPT for accounts_deals, R100 for r100, ADS for ads
  source: string;
  matchStatus: (raw: unknown) => StatusMatch;
  importDate: Date;
  /** Visits → MUU factor (org setting scout.visits_per_unique, default 2.5). */
  visitsPerUnique?: number;
  /** Audience source label, e.g. "pipeline v7" or "Similarweb visits". */
  audienceSource?: string;
  audienceConfidence?: Confidence;
  /** Default account type for created accounts. */
  accountType?: AccountType;
  defaults?: Partial<NormalizedRecord["account"]>;
};

/** Collect mapped values by field key (multi fields keep every non-empty value). */
export function collectFields(cells: CellValue[], headers: (string | null)[], mapping: Mapping): Map<string, CellValue[]> {
  const ids = columnIds(headers);
  const out = new Map<string, CellValue[]>();
  ids.forEach((id, i) => {
    const key = mapping[id];
    if (!key) return;
    const v = cellToValue(cells[i] ?? null);
    if (v == null || (typeof v === "string" && v.trim() === "")) return;
    out.set(key, [...(out.get(key) ?? []), v]);
  });
  return out;
}

/** Turn one mapped row into a NormalizedRecord (or null when it has no identity). */
export function normalizeRow(cells: CellValue[], headers: (string | null)[], mapping: Mapping, rowNumber: number, ctx: NormalizeContext): NormalizedRecord | null {
  const f = collectFields(cells, headers, mapping);
  const one = (k: string): CellValue => f.get(k)?.[0] ?? null;
  const txt = (k: string): string | null => cellText(one(k));
  const issues: NormalizedRecord["issues"] = [];

  const rawDomain = txt("account.domain");
  const domain = normalizeDomain(rawDomain);
  const name = cleanAccountName(txt("account.name"), domain);
  if (!name) return null;
  if (rawDomain && !domain) issues.push({ level: "warning", field: "account.domain", message: `“${rawDomain}” is not a domain — matched by name` });

  const website = rawDomain && isUrl(rawDomain) ? rawDomain : domain ? `https://${domain}` : null;
  const account: NormalizedRecord["account"] = {
    ...(ctx.defaults ?? {}),
    name,
    domain,
    website,
    type: ctx.accountType ?? (ctx.target === "r100" ? "public_company" : ctx.target === "ads" ? "advertiser" : "publisher"),
    category: txt("account.category") ?? ctx.defaults?.category ?? null,
    league: txt("account.league"),
    team: txt("account.team"),
    country: txt("account.country"),
    language: txt("account.language") ?? ctx.defaults?.language ?? null,
    ownership: txt("account.ownership"),
    ticker: txt("account.ticker"),
    tokenName: txt("account.tokenName"),
    isB2c: parseBool(one("account.isB2c")),
    marketCapUsd: parseMarketCapUsd(one("account.marketCap")),
    pressPage: txt("account.pressPage"),
    prEmail: extractEmails(one("account.prEmail"))[0] ?? null,
    linkedinUrl: txt("account.linkedinUrl"),
  };
  if (account.tokenName && isUrl(account.tokenName)) account.tokenName = null;

  // audience
  const audience: NormalizedRecord["audience"] = [];
  const muuRaw = one("audience.muu");
  const muu = parseAudience(muuRaw);
  if (muu != null) audience.push({ metric: "muu", value: muu, rawValue: String(cellText(muuRaw)), source: ctx.audienceSource ?? ctx.source, confidence: ctx.audienceConfidence ?? "reported" });
  else if (cellText(muuRaw)) issues.push({ level: "warning", field: "audience.muu", message: `Could not parse MUU “${cellText(muuRaw)}”` });
  const visitsRaw = one("audience.visits");
  const visits = parseAudience(visitsRaw);
  const factor = ctx.visitsPerUnique ?? 2.5;
  if (visits != null)
    audience.push({
      metric: "visits",
      value: visits,
      rawValue: String(cellText(visitsRaw)),
      source: ctx.audienceSource ?? `${ctx.source} (monthly visits)`,
      confidence: "estimate",
      derivedMuu: Math.round(visits / factor),
      factorUsed: factor,
    });
  const effectiveMuu = muu ?? (visits != null ? Math.round(visits / factor) : null);

  // contacts
  const contacts: NormalizedContact[] = [];
  const primaryEmails = (f.get("contact.email") ?? []).flatMap((v) => extractEmails(v));
  const contactName = txt("contact.name");
  const linkedin = [txt("contact.linkedin"), txt("contact.email")].find((v) => isLinkedinUrl(v)) ?? null;
  if (contactName || primaryEmails.length) {
    const nm = contactName && !/^linkedin$/i.test(contactName) && !extractEmails(contactName).length ? contactName : (primaryEmails[0] ? nameFromEmail(primaryEmails[0]) : null) ?? contactName ?? "";
    if (nm) contacts.push({ fullName: nm, email: primaryEmails[0] ?? null, altEmails: primaryEmails.slice(1), title: txt("contact.title"), phone: txt("contact.phone"), linkedinUrl: linkedin });
  }
  for (const n of [2, 3, 4]) {
    const emails = extractEmails(one(`contact.email${n}`));
    if (!emails.length) continue;
    if (contacts.some((c) => c.email === emails[0])) continue;
    contacts.push({ fullName: nameFromEmail(emails[0]!), email: emails[0]!, title: txt(`contact.title${n}`) });
  }
  const rel = parseRelationshipCell(txt("contact.relationship"));
  if (rel && !contacts.some((c) => c.email && c.email === rel.email)) contacts.push(rel);

  // notes
  const activities: NormalizedActivity[] = [];
  const noteTexts = (f.get("deal.notes") ?? []).map((v) => cellText(v)).filter((v): v is string => !!v);
  for (const n of noteTexts) activities.push(noteActivity(n, ctx.source));

  // deal
  let deal: NormalizedRecord["deal"] = null;
  let statusNote: NormalizedRecord["statusNote"] = null;
  if (ctx.target !== "contacts") {
    const owners = (f.get("deal.owner") ?? []).flatMap((v) => parseOwners(cellText(v)));
    const st = ctx.matchStatus(one("deal.status"));
    let stageKey: string | null = null;
    let lastContactedAt: Date | null = null;
    if (st.kind === "stage") {
      stageKey = st.stageKey;
      lastContactedAt = st.date;
    } else if (st.kind === "date") {
      // a date in the status column means "reached out on …"
      const outreach = ctx.matchStatus("outreach");
      stageKey = outreach.kind === "stage" ? outreach.stageKey : null;
      lastContactedAt = st.date;
      statusNote = { kind: "date", raw: st.raw };
    } else if (st.kind === "unmapped" && parsePriority(st.raw)) {
      // a priority value ("Top 10", "2-High") typed into the status column
      account.priority = parsePriority(st.raw);
    } else if (st.kind === "email" || st.kind === "url" || st.kind === "note" || st.kind === "unmapped") {
      statusNote = { kind: st.kind, raw: st.raw };
      activities.push({ type: "note", subject: `Imported status value (${ctx.source})`, body: st.raw });
      if (st.kind === "email") {
        const e = st.raw.toLowerCase();
        if (!contacts.some((c) => c.email === e)) contacts.push({ fullName: nameFromEmail(e), email: e });
      }
      if (st.kind === "unmapped") issues.push({ level: "warning", field: "deal.status", message: `Unmapped status “${st.raw}” → first stage` });
    }
    if (!stageKey && one("deal.tier") != null) {
      const tierKey = tierToStageKey(one("deal.tier"));
      const viaAlias = tierKey ? ctx.matchStatus(tierKey.replace(/_/g, " ")) : null;
      stageKey = viaAlias?.kind === "stage" ? viaAlias.stageKey : tierKey;
    }

    const override = parseProbability(one("deal.probabilityOverride"));
    const r100: R100Data = {};
    if (ctx.target === "r100") {
      const fp = parseLooseDate(one("r100.firstPostDate"));
      if (fp) r100.firstPostDate = fp.toISOString().slice(0, 10);
      const part = ["r100.m1", "r100.m2", "r100.m3"].map((k) => parseBool(one(k)));
      if (part.some((p) => p != null)) r100.participation = part.map((p) => p === true);
      const pc = Number(cellText(one("r100.postCount")));
      if (Number.isFinite(pc) && pc > 0) r100.postCount = Math.round(pc);
      const profile = txt("r100.profileUrl");
      if (profile && isUrl(profile)) r100.profileUrl = profile;
      const links = (f.get("r100.editorialLink") ?? []).map((v) => cellText(v)).filter((v): v is string => !!v && isUrl(v));
      if (links.length) r100.editorialLinks = links;
      const bonus = parseMoneyToCents(one("r100.bonus"));
      if (bonus) {
        r100.bonusCents = bonus;
        r100.bonusEligible = true;
      }
    }
    deal = {
      pipelineKey: ctx.pipelineKey,
      stageKey,
      statusRaw: cellText(one("deal.status")),
      owners,
      priority: parsePriority(one("deal.priority")) ?? account.priority ?? null,
      nextStep: txt("deal.nextStep"),
      muu: ctx.target === "accounts_deals" ? effectiveMuu : null,
      probabilityOverride: override,
      overrideReason: override != null ? `Imported from ${ctx.source}` : null,
      overrideStatus: override != null ? "pending" : null,
      contractValueCents: parseMoneyToCents(one("deal.contractValue")),
      annualizedValueCents: parseMoneyToCents(one("deal.annualized")),
      nextPaymentCents: parseMoneyToCents(one("deal.nextPayment")),
      r100: Object.keys(r100).length ? r100 : undefined,
      lastContactedAt,
    };
    if (deal.priority) account.priority = deal.priority;
  }

  return { rowNumber, source: ctx.source, account, audience, deal, contacts, activities, issues, statusNote };
}

/** "Met 7/1/26. Attendees: X." → meeting activity; everything else → note. */
export function noteActivity(text: string, source: string): NormalizedActivity {
  const met = text.match(/^met\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (met) return { type: "meeting", subject: `Meeting (imported from ${source})`, body: text, occurredAt: parseLooseDate(met[1]) };
  return { type: "note", subject: `Imported note (${source})`, body: text, occurredAt: null };
}

/** Normalize from a { fieldKey: value | value[] } object (used by the migration script's per-sheet extractors). */
export function normalizeFields(fields: Record<string, CellValue | CellValue[] | undefined>, rowNumber: number, ctx: NormalizeContext): NormalizedRecord | null {
  const headers: string[] = [];
  const cells: CellValue[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      headers.push(k);
      cells.push(x ?? null);
    }
  }
  const ids = columnIds(headers);
  const mapping: Mapping = Object.fromEntries(ids.map((id, i) => [id, headers[i]!]));
  return normalizeRow(cells, headers, mapping, rowNumber, ctx);
}
