/**
 * Import targets, mappable fields and header auto-mapping (PRD IMP-1). Pure — usable from client components.
 */
import { nameSimilarity } from "./dedupe";

export const IMPORT_TARGETS = [
  { key: "accounts_deals", label: "Accounts + deals", description: "Publishers/brands with a deal in the chosen pipeline (NET, ENT, SPT…).", needsPipeline: true },
  { key: "contacts", label: "Contacts", description: "People, linked to accounts by domain or company name.", needsPipeline: false },
  { key: "r100", label: "Roundtable 100", description: "Public companies & token projects with R100 activation data.", needsPipeline: false },
  { key: "ads", label: "TheStreet sponsorships (ADS)", description: "Sponsorship deals with next payment & annualized value.", needsPipeline: false },
] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number]["key"];

export type FieldDef = {
  key: string;
  label: string;
  group: "Account" | "Audience" | "Deal" | "Contact" | "R100" | "ADS";
  synonyms: string[];
  targets: ImportTarget[];
  /** Field can be mapped from several columns (values are concatenated / collected). */
  multi?: boolean;
};

const ALL: ImportTarget[] = ["accounts_deals", "contacts", "r100", "ads"];
const DEALS: ImportTarget[] = ["accounts_deals", "r100", "ads"];

export const FIELDS: FieldDef[] = [
  { key: "account.name", label: "Account name", group: "Account", synonyms: ["media name", "name", "company", "company name", "publisher", "outlet", "account", "brand", "channel", "fp"], targets: ALL },
  { key: "account.domain", label: "Domain / website", group: "Account", synonyms: ["domain", "website", "url", "site", "web"], targets: ALL },
  { key: "account.category", label: "Category / vertical", group: "Account", synonyms: ["category", "vertical", "sector", "industry"], targets: ["accounts_deals", "r100", "ads"] },
  { key: "account.league", label: "Sport / league", group: "Account", synonyms: ["sport/league", "league", "sport"], targets: ["accounts_deals"] },
  { key: "account.team", label: "Team", group: "Account", synonyms: ["team"], targets: ["accounts_deals"] },
  { key: "account.country", label: "Country", group: "Account", synonyms: ["country", "geo", "region"], targets: ["accounts_deals", "r100"] },
  { key: "account.language", label: "Language", group: "Account", synonyms: ["language", "lang"], targets: ["accounts_deals"] },
  { key: "account.ownership", label: "Ownership", group: "Account", synonyms: ["ownership", "ownership / status", "owner group", "parent"], targets: ["accounts_deals"] },
  { key: "account.ticker", label: "Ticker", group: "Account", synonyms: ["ticker", "symbol"], targets: ["r100", "ads", "accounts_deals"] },
  { key: "account.tokenName", label: "Token name", group: "Account", synonyms: ["token name", "token"], targets: ["r100"] },
  { key: "account.isB2c", label: "B2C?", group: "Account", synonyms: ["b2c?", "b2c"], targets: ["r100"] },
  { key: "account.marketCap", label: "Market cap", group: "Account", synonyms: ["market cap", "mkt cap", "marketcap"], targets: ["r100"] },
  { key: "account.pressPage", label: "Press page", group: "Account", synonyms: ["press page", "newsroom"], targets: ["r100"] },
  { key: "account.prEmail", label: "PR email", group: "Account", synonyms: ["pr email", "press email", "media email"], targets: ["r100"] },
  { key: "account.linkedinUrl", label: "Company LinkedIn", group: "Account", synonyms: ["company linkedin"], targets: ["accounts_deals", "r100"] },
  { key: "audience.muu", label: "MUU (monthly unique users)", group: "Audience", synonyms: ["muu", "monthly uniques", "est. monthly uniques", "uniques", "monthly unique users"], targets: ["accounts_deals", "contacts"] },
  { key: "audience.visits", label: "Monthly visits (not MUU)", group: "Audience", synonyms: ["monthly visits", "monthly (sw)", "visits", "traffic", "similarweb"], targets: ["accounts_deals", "contacts"] },
  { key: "deal.status", label: "Status → stage", group: "Deal", synonyms: ["status", "stage", "deal status"], targets: DEALS },
  { key: "deal.tier", label: "Tier / probability tier", group: "Deal", synonyms: ["tier"], targets: ["accounts_deals"] },
  { key: "deal.probabilityOverride", label: "Probability override", group: "Deal", synonyms: ["probability override", "override"], targets: DEALS },
  { key: "deal.owner", label: "Owner / rep (splits)", group: "Deal", synonyms: ["rep", "owner", "sdr", "source", "sales rep", "account owner"], targets: [...DEALS, "contacts"] },
  { key: "deal.priority", label: "Priority", group: "Deal", synonyms: ["priority", "account tier"], targets: DEALS },
  { key: "deal.nextStep", label: "Next step", group: "Deal", synonyms: ["next steps", "next step", "todo"], targets: DEALS },
  { key: "deal.notes", label: "Notes", group: "Deal", synonyms: ["notes", "note", "comments", "chris notes", "reason"], targets: [...DEALS, "contacts"], multi: true },
  { key: "deal.adsCategory", label: "ADS category (Active / Current client / Warm)", group: "ADS", synonyms: ["category"], targets: ["ads"] },
  { key: "deal.nextPayment", label: "Next payment ($)", group: "ADS", synonyms: ["next payment deal value ($)", "next payment", "deal value", "payment"], targets: ["ads"] },
  { key: "deal.annualized", label: "Annualized ($)", group: "ADS", synonyms: ["annualized ($)", "annualized", "annual value", "arr"], targets: ["ads"] },
  { key: "deal.contractValue", label: "Contract value ($)", group: "ADS", synonyms: ["contract value", "value ($)", "amount"], targets: ["ads"] },
  { key: "r100.firstPostDate", label: "First post date", group: "R100", synonyms: ["first post date"], targets: ["r100"] },
  { key: "r100.m1", label: "Month 1 participation", group: "R100", synonyms: ["mo. 1 participation", "month 1"], targets: ["r100"] },
  { key: "r100.m2", label: "Month 2 participation", group: "R100", synonyms: ["mo. 2 participation", "month 2"], targets: ["r100"] },
  { key: "r100.m3", label: "Month 3 participation", group: "R100", synonyms: ["mo. 3 participation", "month 3"], targets: ["r100"] },
  { key: "r100.postCount", label: "Channel post count", group: "R100", synonyms: ["rtb100 channel posts", "posts", "post count"], targets: ["r100"] },
  { key: "r100.profileUrl", label: "Profile link", group: "R100", synonyms: ["profile link", "profile url", "profile"], targets: ["r100"] },
  { key: "r100.editorialLink", label: "Editorial / extra links", group: "R100", synonyms: ["extra links:", "extra links", "editorial links", "links"], targets: ["r100"], multi: true },
  { key: "r100.bonus", label: "Bonus ($)", group: "R100", synonyms: ["bonus"], targets: ["r100"] },
  { key: "contact.name", label: "Contact name", group: "Contact", synonyms: ["poc name", "poc", "contact name", "full name", "contact", "guest"], targets: ALL },
  { key: "contact.email", label: "Contact email", group: "Contact", synonyms: ["poc contact", "email", "contact email", "poc email", "email 1"], targets: ALL },
  { key: "contact.title", label: "Contact title", group: "Contact", synonyms: ["title", "poc title", "job title", "role"], targets: ALL },
  { key: "contact.phone", label: "Contact phone", group: "Contact", synonyms: ["phone", "mobile", "tel"], targets: ALL },
  { key: "contact.linkedin", label: "Contact LinkedIn", group: "Contact", synonyms: ["linkedin url", "linkedin", "poc linkedin", "linkedinurl"], targets: ALL },
  { key: "contact.email2", label: "Contact 2 email", group: "Contact", synonyms: ["email 2"], targets: ALL },
  { key: "contact.title2", label: "Contact 2 title", group: "Contact", synonyms: [], targets: ALL },
  { key: "contact.email3", label: "Contact 3 email", group: "Contact", synonyms: ["email 3"], targets: ALL },
  { key: "contact.title3", label: "Contact 3 title", group: "Contact", synonyms: [], targets: ALL },
  { key: "contact.email4", label: "Contact 4 email", group: "Contact", synonyms: ["email 4"], targets: ALL },
  { key: "contact.title4", label: "Contact 4 title", group: "Contact", synonyms: [], targets: ALL },
  { key: "contact.relationship", label: "Internal exec / relationship", group: "Contact", synonyms: ["internal executive/relationship(name and contact)", "top executive / relationship", "relationship"], targets: ["r100", "accounts_deals"] },
];

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function fieldsFor(target: ImportTarget): FieldDef[] {
  return FIELDS.filter((f) => f.targets.includes(target));
}

/** Column ids: header text, disambiguated by occurrence ("Title", "Title #2", …); blank headers → "Column C". */
export function columnIds(headers: (string | null)[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = (h ?? "").trim() || `Column ${columnLetter(i)}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n > 1 ? `${base} #${n}` : base;
  });
}

export function columnLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normHeader(h: string): string {
  return h.toLowerCase().replace(/#\d+$/, "").replace(/\s+/g, " ").trim();
}

export type Mapping = Record<string, string>; // column id → field key ("" = ignore)

/**
 * Suggest a mapping from header similarity: exact synonym → contains → bigram similarity ≥ 0.72.
 * Single-valued fields are used at most once; repeated "Title"/"Email" columns fill contact slots 2–4.
 */
export function suggestMapping(headers: (string | null)[], target: ImportTarget): Mapping {
  const ids = columnIds(headers);
  const fields = fieldsFor(target);
  const used = new Set<string>();
  const mapping: Mapping = {};
  const take = (id: string, key: string) => {
    mapping[id] = key;
    const f = FIELD_BY_KEY.get(key);
    if (!f?.multi) used.add(key);
  };
  const free = (key: string) => {
    const f = FIELD_BY_KEY.get(key);
    return fields.some((x) => x.key === key) && (f?.multi || !used.has(key));
  };
  const slot = (kind: "email" | "title") => {
    for (const k of [`contact.${kind}`, `contact.${kind}2`, `contact.${kind}3`, `contact.${kind}4`]) if (free(k)) return k;
    return null;
  };

  // pass 1: exact synonyms
  ids.forEach((id) => {
    const h = normHeader(id);
    if (!h || h.startsWith("column ")) return;
    if (/^title$/.test(h) || /^(poc )?title$/.test(h)) {
      const k = slot("title");
      if (k) take(id, k);
      return;
    }
    if (/^email( \d)?$/.test(h)) {
      const k = slot("email");
      if (k) take(id, k);
      return;
    }
    const exact = fields.find((f) => free(f.key) && f.synonyms.includes(h));
    if (exact) take(id, exact.key);
  });
  // pass 2: contains / similarity
  ids.forEach((id) => {
    if (mapping[id]) return;
    const h = normHeader(id);
    if (!h || h.startsWith("column ")) return;
    let best: { key: string; score: number } | null = null;
    for (const f of fields) {
      if (!free(f.key)) continue;
      for (const syn of f.synonyms) {
        const score = h.includes(syn) && syn.length >= 4 ? 0.9 : nameSimilarity(h, syn);
        if (score >= 0.72 && (!best || score > best.score)) best = { key: f.key, score };
      }
    }
    if (best) take(id, best.key);
  });
  for (const id of ids) if (!(id in mapping)) mapping[id] = "";
  return mapping;
}

/** Re-key a saved template (header → field) onto a new file's column ids. */
export function applyTemplate(headers: (string | null)[], template: Mapping, target: ImportTarget): Mapping {
  const ids = columnIds(headers);
  const suggested = suggestMapping(headers, target);
  const out: Mapping = {};
  for (const id of ids) out[id] = id in template ? template[id]! : suggested[id] ?? "";
  return out;
}
