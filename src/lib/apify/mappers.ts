/**
 * Actor output → typed records (PRD SCOUT-20: "validates actor output against the mapping schema and quarantines
 * malformed results"). Pure — unit tested with fixtures.
 *
 * Each purpose has a zod schema for the normalized record. Raw dataset items are first projected through the
 * registry's `outputMapping` (targetField → dot.path in the raw item), then through built-in heuristics that know
 * the common field names of the seeded actors. Anything that fails the schema goes to `quarantined`.
 */
import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";

export const PURPOSES = [
  "traffic",
  "lookalike",
  "serp",
  "tech_stack",
  "website_contacts",
  "people",
  "email_from_linkedin",
  "email_finder",
  "email_verify",
  "research",
] as const;
export type Purpose = (typeof PURPOSES)[number];

const domainField = z
  .string()
  .transform((v, ctx) => {
    const d = normalizeDomain(v);
    if (!d) {
      ctx.addIssue({ code: "custom", message: "not a domain" });
      return z.NEVER;
    }
    return d;
  });
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());
const optStr = z.string().trim().min(1).nullable().optional().transform((v) => v ?? null);
const optNum = z.number().finite().nullable().optional().transform((v) => v ?? null);

export const trafficSchema = z.object({
  domain: domainField,
  name: optStr,
  monthlyVisits: z.number().finite().nonnegative().nullable(),
  trendPct: optNum, // −0.18 = −18% over ~3 months
  topCountry: optStr,
  category: optStr,
  globalRank: optNum,
  series: z.array(z.number()).optional().default([]),
});
export type TrafficRecord = z.infer<typeof trafficSchema>;

export const lookalikeSchema = z.object({ domain: domainField, seed: z.string().nullable(), similarity: z.number().min(0).max(1).nullable() });
export type LookalikeRecord = z.infer<typeof lookalikeSchema>;

export const serpSchema = z.object({ domain: domainField, title: optStr, query: optStr, url: optStr });
export type SerpRecord = z.infer<typeof serpSchema>;

export const techStackSchema = z.object({ domain: domainField, technologies: z.array(z.string().min(1)).default([]) });
export type TechStackRecord = z.infer<typeof techStackSchema>;

const personLite = z.object({ name: z.string().min(2), title: optStr, email: emailField.nullable().optional().transform((v) => v ?? null) });
export const websiteContactsSchema = z.object({
  domain: domainField,
  emails: z.array(emailField).default([]),
  linkedinUrls: z.array(z.string()).default([]),
  companyLinkedinUrl: optStr,
  people: z.array(personLite).default([]),
});
export type WebsiteContactsRecord = z.infer<typeof websiteContactsSchema>;

export const personSchema = z.object({
  fullName: z.string().trim().min(2),
  firstName: optStr,
  lastName: optStr,
  title: optStr,
  linkedinUrl: optStr,
  email: emailField.nullable().optional().transform((v) => v ?? null),
});
export type PersonRecord = z.infer<typeof personSchema>;

export const linkedinEmailSchema = z.object({ linkedinUrl: z.string().min(5), email: emailField });
export type LinkedinEmailRecord = z.infer<typeof linkedinEmailSchema>;

export const emailFinderSchema = z.object({ fullName: optStr, email: emailField, domain: optStr, confidence: optNum });
export type EmailFinderRecord = z.infer<typeof emailFinderSchema>;

export const verifySchema = z.object({ email: emailField, verification: z.enum(["valid", "risky", "invalid", "unknown"]), raw: optStr });
export type VerifyRecord = z.infer<typeof verifySchema>;

export const researchSchema = z.object({ url: z.string().min(4), title: optStr, text: optStr });

/* ───────────── helpers ───────────── */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (isObj(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

function first(obj: Obj, keys: string[]): unknown {
  for (const k of keys) {
    const v = k.includes(".") ? getPath(obj, k) : obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function firstNum(obj: Obj, keys: string[]): number | null {
  for (const k of keys) {
    const n = toNumber(k.includes(".") ? getPath(obj, k) : obj[k]);
    if (n != null) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase().replace(/,/g, "");
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([kmb])?$/);
    if (!m) return null;
    const mult = m[2] === "b" ? 1e9 : m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
    return Number(m[1]) * mult;
  }
  return null;
}

function strings(v: unknown): string[] {
  if (Array.isArray(v))
    return v
      .map((x) => (typeof x === "string" ? x : isObj(x) ? str(first(x, ["value", "email", "url", "name", "Name"])) : null))
      .filter((x): x is string => Boolean(x));
  if (typeof v === "string") return v.split(/[,;\s]+/).filter(Boolean);
  return [];
}

/** Apply registry outputMapping {target: "path.in.raw"} over the raw item. */
export function applyMapping(item: unknown, mapping: Record<string, string> | null | undefined): Obj {
  const base: Obj = isObj(item) ? { ...item } : {};
  if (mapping) for (const [target, path] of Object.entries(mapping)) {
    const v = getPath(item, path);
    if (v !== undefined) base[target] = v;
  }
  return base;
}

/** Monthly visits series: accepts {"2026-06-01": 123, …} or [{date, visits}] or number[]. Returns chronological values. */
export function visitsSeries(v: unknown): number[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "number" ? x : isObj(x) ? toNumber(first(x, ["visits", "value", "count"])) : null))
      .filter((x): x is number => x != null);
  }
  if (isObj(v)) {
    return Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, x]) => toNumber(x))
      .filter((x): x is number => x != null);
  }
  return [];
}

/** Trend over the series: (last − first) / first, using up to the last 3 months. */
export function trendFromSeries(series: number[]): number | null {
  const s = series.slice(-3);
  if (s.length < 2 || !s[0]) return null;
  return Math.round(((s[s.length - 1]! - s[0]) / s[0]) * 1000) / 1000;
}

const CATEGORY_MAP: [RegExp, string][] = [
  [/crypto|blockchain|bitcoin|web3/i, "Crypto"],
  [/financ|invest|stock|bank|economy|money/i, "Finance"],
  [/politic|government|law/i, "Politics"],
  [/sport|football|soccer|basketball|baseball|hockey|nfl|nba/i, "Sports"],
  [/artificial.intel|\bai\b|machine.learn/i, "AI"],
  [/defen[cs]e|military/i, "Military/Defense"],
  [/tech|computer|electronics|software/i, "Emerging Tech"],
  [/business|industry/i, "Business"],
  [/news|media|publishing/i, "News"],
  [/game|gaming/i, "Gaming"],
  [/health|medic/i, "Healthcare"],
  [/travel/i, "Travel/Adventure"],
  [/food|recipe|cooking/i, "Food"],
  [/real.estate/i, "Real Estate"],
  [/lifestyle|fashion|beauty/i, "Lifestyle"],
  [/entertain|tv|movie|celebrit|music/i, "Entertainment"],
];

/** Similarweb-style "News_and_Media/Business_News" → CRM category. */
export function mapCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/[_/]+/g, " ");
  for (const [re, cat] of CATEGORY_MAP) if (re.test(text)) return cat;
  return null;
}

/** Map verifier verdict strings to our enum. */
export function mapVerdict(raw: unknown): "valid" | "risky" | "invalid" | "unknown" {
  if (typeof raw === "boolean") return raw ? "valid" : "invalid";
  const s = String(raw ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "unknown";
  if (/^(valid|deliverable|ok|safe|verified|good)$/.test(s)) return "valid";
  if (/catch_?all|accept_?all|risky|role|accept|unverifiable/.test(s)) return "risky";
  if (/invalid|undeliverable|bounce|disposable|spamtrap|bad|syntax|not_?exist|no_?mx/.test(s)) return "invalid";
  return "unknown";
}

const PLATFORM_DOMAINS = new Set([
  "google.com", "youtube.com", "wikipedia.org", "facebook.com", "twitter.com", "x.com", "linkedin.com", "reddit.com",
  "instagram.com", "tiktok.com", "amazon.com", "apple.com", "medium.com", "similarweb.com", "apify.com", "quora.com",
  "pinterest.com", "github.com", "substack.com", "yelp.com", "crunchbase.com", "semrush.com", "ahrefs.com", "feedspot.com",
]);
export function isPlatformDomain(d: string): boolean {
  if (PLATFORM_DOMAINS.has(d)) return true;
  const parts = d.split(".");
  return parts.length > 2 && PLATFORM_DOMAINS.has(parts.slice(-2).join("."));
}

/* ───────────── per-purpose heuristics (raw → candidate object before zod) ───────────── */

function preTraffic(o: Obj): Obj {
  const seriesRaw = first(o, ["estimatedMonthlyVisits", "monthlyVisitsHistory", "visitsHistory", "traffic.history", "EstimatedMonthlyVisits"]);
  const series = visitsSeries(seriesRaw);
  let visits = firstNum(o, ["monthlyVisits", "totalVisits", "visits", "engagements.visits", "traffic.visits", "Engagments.Visits"]);
  if (visits == null && series.length) visits = series[series.length - 1]!;
  const trend = firstNum(o, ["trendPct"]) ?? trendFromSeries(series);
  const topCountryRaw = first(o, ["topCountry", "topCountryShares.0.countryCode", "topCountryShares.0.country", "topCountries.0.countryCode", "topCountries.0.country", "countryRank.countryCode", "countryRank.country"]);
  const categoryRaw = str(first(o, ["category", "categoryRank.category", "siteCategory", "Category"]));
  return {
    domain: str(first(o, ["domain", "siteName", "site", "website", "url", "name"])),
    name: str(first(o, ["title", "siteTitle", "name"])),
    monthlyVisits: visits,
    trendPct: trend,
    topCountry: str(topCountryRaw)?.toUpperCase().slice(0, 3) ?? null,
    category: (categoryRaw && (mapCategory(categoryRaw) ?? categoryRaw)) || null,
    globalRank: firstNum(o, ["globalRank", "globalRank.rank", "GlobalRank.Rank", "rank"]),
    series,
  };
}

function preLookalike(o: Obj): Obj[] {
  const seed = str(first(o, ["domain", "url", "website", "input", "siteName"]));
  const list = first(o, ["similarSites", "similar_sites", "similarSitesList", "competitors", "SimilarSites"]);
  if (Array.isArray(list)) {
    return list.map((x) =>
      isObj(x)
        ? {
            domain: str(first(x, ["domain", "site", "url", "name", "Site"])),
            seed: seed ? normalizeDomain(seed) : null,
            similarity: normSimilarity(toNumber(first(x, ["similarity", "score", "affinity", "Score"]))),
          }
        : { domain: str(x), seed: seed ? normalizeDomain(seed) : null, similarity: null },
    );
  }
  return [{ domain: seed, seed: str(o.seed) ?? null, similarity: normSimilarity(toNumber(o.similarity)) }];
}
function normSimilarity(n: number | null): number | null {
  if (n == null) return null;
  const v = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
}

function preSerp(o: Obj): Obj[] {
  const query = str(first(o, ["searchQuery.term", "query", "searchTerm", "keyword"]));
  const organic = first(o, ["organicResults", "results", "organic"]);
  if (Array.isArray(organic))
    return organic.filter(isObj).map((r) => ({ domain: str(first(r, ["url", "link", "displayedUrl"])), title: str(r.title), query, url: str(first(r, ["url", "link"])) }));
  return [{ domain: str(first(o, ["url", "link", "displayedUrl", "domain"])), title: str(o.title), query, url: str(first(o, ["url", "link"])) }];
}

function preTech(o: Obj): Obj {
  const techs = new Set<string>();
  const add = (v: unknown) => {
    for (const t of strings(v)) techs.add(t);
  };
  add(first(o, ["technologies", "Technologies", "tech", "techStack"]));
  const groups = first(o, ["groups", "Results.0.Result.Paths.0.Technologies"]);
  if (Array.isArray(groups))
    for (const g of groups) {
      if (!isObj(g)) continue;
      add(g.Name ?? g.name);
      const cats = g.categories ?? g.Categories;
      if (Array.isArray(cats)) for (const c of cats) if (isObj(c)) add(c.live ?? c.Live ?? c.technologies);
    }
  return { domain: str(first(o, ["domain", "Domain", "url", "Lookup", "website"])), technologies: [...techs].slice(0, 80) };
}

function preWebsiteContacts(o: Obj): Obj {
  const linkedins = strings(first(o, ["linkedIns", "linkedins", "linkedin", "linkedInUrls", "socials.linkedin"]));
  const company = linkedins.find((u) => /linkedin\.com\/company\//i.test(u)) ?? null;
  const peopleRaw = first(o, ["contacts", "people", "persons", "team"]);
  const people = Array.isArray(peopleRaw)
    ? peopleRaw.filter(isObj).map((p) => ({ name: str(first(p, ["name", "fullName"])), title: str(first(p, ["title", "position", "role"])), email: str(p.email) }))
    : [];
  const emails = strings(first(o, ["emails", "email", "emailAddresses"])).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e));
  return {
    domain: str(first(o, ["domain", "url", "website", "startUrl", "sourceUrl"])),
    emails: [...new Set(emails.map((e) => e.toLowerCase()))],
    linkedinUrls: linkedins,
    companyLinkedinUrl: company,
    people: people.filter((p) => p.name),
  };
}

function prePerson(o: Obj): Obj {
  const firstName = str(first(o, ["firstName", "first_name"]));
  const lastName = str(first(o, ["lastName", "last_name"]));
  const fullName = str(first(o, ["fullName", "name", "full_name"])) ?? ([firstName, lastName].filter(Boolean).join(" ") || null);
  const email = str(first(o, ["email", "emails.0.email", "emails.0", "workEmail"]));
  return {
    fullName,
    firstName,
    lastName,
    title: str(first(o, ["title", "position", "jobTitle", "headline", "currentPosition.0.position", "experience.0.position"])),
    linkedinUrl: str(first(o, ["linkedinUrl", "profileUrl", "url", "linkedin"])),
    email: email && /@/.test(email) ? email : null,
  };
}

function preLinkedinEmail(o: Obj): Obj {
  return { linkedinUrl: str(first(o, ["linkedinUrl", "url", "profileUrl", "input"])), email: str(first(o, ["email", "emails.0", "emails.0.email", "workEmail"])) };
}

function preEmailFinder(o: Obj): Obj {
  const fullName = str(first(o, ["fullName", "name"])) ?? ([str(o.firstName), str(o.lastName)].filter(Boolean).join(" ") || null);
  return {
    fullName,
    email: str(first(o, ["email", "result.email", "foundEmail"])),
    domain: str(first(o, ["domain", "companyDomain"])),
    confidence: normSimilarity(toNumber(first(o, ["confidence", "score"]))),
  };
}

function preVerify(o: Obj): Obj {
  const verdict = first(o, ["verification", "result", "status", "verdict", "state", "isValid", "valid"]);
  return { email: str(first(o, ["email", "address", "input"])), verification: mapVerdict(verdict), raw: str(verdict) };
}

function preResearch(o: Obj): Obj {
  return { url: str(first(o, ["url", "metadata.url", "crawl.loadedUrl"])), title: str(first(o, ["title", "metadata.title"])), text: str(first(o, ["markdown", "text"]))?.slice(0, 4000) ?? null };
}

/* ───────────── public API ───────────── */

export type Quarantined = { index: number; reason: string; sample: string };
export type Mapped<T> = { records: T[]; quarantined: Quarantined[] };

type Spec = { pre: (o: Obj) => Obj | Obj[]; schema: z.ZodType };
const SPECS: Record<Purpose, Spec> = {
  traffic: { pre: preTraffic, schema: trafficSchema },
  lookalike: { pre: preLookalike, schema: lookalikeSchema },
  serp: { pre: preSerp, schema: serpSchema },
  tech_stack: { pre: preTech, schema: techStackSchema },
  website_contacts: { pre: preWebsiteContacts, schema: websiteContactsSchema },
  people: { pre: prePerson, schema: personSchema },
  email_from_linkedin: { pre: preLinkedinEmail, schema: linkedinEmailSchema },
  email_finder: { pre: preEmailFinder, schema: emailFinderSchema },
  email_verify: { pre: preVerify, schema: verifySchema },
  research: { pre: preResearch, schema: researchSchema },
};

export type RecordFor<P extends Purpose> = P extends "traffic"
  ? TrafficRecord
  : P extends "lookalike"
    ? LookalikeRecord
    : P extends "serp"
      ? SerpRecord
      : P extends "tech_stack"
        ? TechStackRecord
        : P extends "website_contacts"
          ? WebsiteContactsRecord
          : P extends "people"
            ? PersonRecord
            : P extends "email_from_linkedin"
              ? LinkedinEmailRecord
              : P extends "email_finder"
                ? EmailFinderRecord
                : P extends "email_verify"
                  ? VerifyRecord
                  : z.infer<typeof researchSchema>;

/** Map + validate raw dataset items for a purpose. Malformed items are quarantined, never thrown. */
export function mapItems<P extends Purpose>(purpose: P, items: unknown[], mapping?: Record<string, string> | null): Mapped<RecordFor<P>> {
  const spec = SPECS[purpose];
  const records: RecordFor<P>[] = [];
  const quarantined: Quarantined[] = [];
  items.forEach((item, index) => {
    if (!isObj(item)) {
      quarantined.push({ index, reason: "item is not an object", sample: String(item).slice(0, 200) });
      return;
    }
    const projected = applyMapping(item, mapping);
    // mapped target fields are read first by the heuristics (they check the canonical field name first)
    const pre = spec.pre(projected);
    const candidates = Array.isArray(pre) ? pre : [pre];
    for (const c of candidates) {
      const res = spec.schema.safeParse(c);
      if (res.success) records.push(res.data as RecordFor<P>);
      else
        quarantined.push({
          index,
          reason: res.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ").slice(0, 300),
          sample: JSON.stringify(item).slice(0, 300),
        });
    }
  });
  return { records, quarantined };
}
