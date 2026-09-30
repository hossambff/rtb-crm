/**
 * Scout search criteria: zod schema (shared by forms, actions, AI) + deterministic natural-language fallback parser
 * (SCOUT-2 when AI is unavailable). Pure — unit tested.
 */
import { z } from "zod";
import { normalizeDomain, parseAudience } from "@/lib/domain";

export const OWNERSHIP_OPTIONS = ["independent", "founder_led", "group_owned", "public_company"] as const;
export const OWNERSHIP_LABELS: Record<string, string> = {
  independent: "Independent",
  founder_led: "Founder-led",
  group_owned: "Group-owned",
  public_company: "Public company",
};

export const SCOUT_CATEGORIES = ["Finance", "Crypto", "Politics", "News", "Business", "AI", "Emerging Tech", "Military/Defense", "Sports", "Local News", "Gaming", "Lifestyle", "Entertainment", "Healthcare", "Real Estate", "Travel/Adventure"];

const domainList = z
  .array(z.string())
  .default([])
  .transform((arr) => [...new Set(arr.map((d) => normalizeDomain(d)).filter((d): d is string => Boolean(d)))]);

export const criteriaSchema = z
  .object({
    categories: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    countries: z.array(z.string().trim().toUpperCase().min(2).max(3)).max(30).default([]),
    languages: z.array(z.string().trim().toLowerCase().min(2).max(5)).max(10).default([]),
    muuMin: z.number().int().nonnegative().nullable().optional(),
    muuMax: z.number().int().positive().nullable().optional(),
    ownership: z.array(z.enum(OWNERSHIP_OPTIONS)).default([]),
    keywords: z.array(z.string().trim().min(2).max(120)).max(10).default([]),
    seedDomains: domainList,
    domains: domainList,
    excludeDomains: domainList,
    /** domain → manually entered MUU (domain-list scoring without Apify). */
    manualMuu: z.record(z.string(), z.number().int().nonnegative()).default({}),
    includeTechStack: z.boolean().default(false),
    notInPipeline: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .refine((c) => c.muuMin == null || c.muuMax == null || c.muuMin <= c.muuMax, { message: "MUU min must be ≤ max", path: ["muuMax"] });
export type Criteria = z.infer<typeof criteriaSchema>;

/** Schema the AI fills from natural language (kept flat & simple for small models). */
export const nlCriteriaSchema = z.object({
  categories: z.array(z.string()).describe("Verticals, e.g. Finance, Crypto, Politics, News, Sports, AI"),
  countries: z.array(z.string()).describe("ISO-3166 alpha-2 country codes, e.g. US, GB, IE"),
  languages: z.array(z.string()).describe("ISO-639-1 language codes"),
  muuMin: z.number().nullable().describe("Minimum monthly unique users, or null"),
  muuMax: z.number().nullable().describe("Maximum monthly unique users, or null"),
  ownership: z.array(z.enum(OWNERSHIP_OPTIONS)),
  keywords: z.array(z.string()).describe("Short Google search phrases to discover matching sites"),
  seedDomains: z.array(z.string()).describe("Example sites to find lookalikes of"),
  notInPipeline: z.boolean(),
  limit: z.number().nullable().describe("How many results the user asked for"),
});

const COUNTRY_WORDS: [RegExp, string][] = [
  [/\b(us|usa|u\.s\.|united states|american?)\b/i, "US"],
  [/\b(uk|u\.k\.|united kingdom|british|britain|england)\b/i, "GB"],
  [/\b(ireland|irish)\b/i, "IE"],
  [/\b(canada|canadian)\b/i, "CA"],
  [/\b(australia|australian)\b/i, "AU"],
  [/\b(spain|spanish)\b/i, "ES"],
  [/\b(mexico|mexican)\b/i, "MX"],
  [/\b(argentina|argentinian)\b/i, "AR"],
  [/\b(colombia|colombian)\b/i, "CO"],
  [/\b(india|indian)\b/i, "IN"],
  [/\b(poland|polish)\b/i, "PL"],
  [/\b(germany|german)\b/i, "DE"],
  [/\b(france|french)\b/i, "FR"],
];

const CATEGORY_WORDS: [RegExp, string][] = [
  [/\bfinanc\w*|\binvest\w*|\bmarkets?\b/i, "Finance"],
  [/\bcrypto\w*|\bbitcoin|\bblockchain|\bweb3\b/i, "Crypto"],
  [/\bpolitic\w*/i, "Politics"],
  [/\bnews\b/i, "News"],
  [/\bsports?\b|\bfan sites?\b|\bnfl\b|\bnba\b|\bpremier league\b/i, "Sports"],
  [/\bai\b|\bartificial intelligence\b/i, "AI"],
  [/\btech\b|\btechnology\b/i, "Emerging Tech"],
  [/\bdefen[cs]e\b|\bmilitary\b/i, "Military/Defense"],
  [/\bbusiness\b/i, "Business"],
  [/\bgaming\b|\bvideo games?\b/i, "Gaming"],
];

/** Deterministic NL → criteria (fallback when AI is off or fails). */
export function heuristicCriteria(text: string): Criteria {
  const t = ` ${text} `;
  const countries = [...new Set(COUNTRY_WORDS.filter(([re]) => re.test(t)).map(([, c]) => c))];
  const categories = [...new Set(CATEGORY_WORDS.filter(([re]) => re.test(t)).map(([, c]) => c))];
  const ownership: Criteria["ownership"] = [];
  if (/\bindependent\b|\bindie\b/i.test(t)) ownership.push("independent");
  if (/\bfounder[- ]led\b/i.test(t)) ownership.push("founder_led");
  if (/\bgroup[- ]owned\b/i.test(t)) ownership.push("group_owned");

  let muuMin: number | null = null;
  let muuMax: number | null = null;
  const range = t.match(/(\d+(?:\.\d+)?\s*[kmb]?)\s*(?:–|—|-|to)\s*(\d+(?:\.\d+)?\s*[kmb])\b/i);
  if (range) {
    const hiUnit = range[2]!.trim().slice(-1);
    const lo = /[kmb]$/i.test(range[1]!.trim()) ? range[1]! : `${range[1]}${hiUnit}`;
    muuMin = parseAudience(lo.replace(/\s/g, ""));
    muuMax = parseAudience(range[2]!.replace(/\s/g, ""));
  } else {
    const over = t.match(/(?:over|above|more than|at least|>)\s*(\d+(?:\.\d+)?\s*[kmb])\b/i);
    const under = t.match(/(?:under|below|less than|up to|<)\s*(\d+(?:\.\d+)?\s*[kmb])\b/i);
    if (over) muuMin = parseAudience(over[1]!.replace(/\s/g, ""));
    if (under) muuMax = parseAudience(under[1]!.replace(/\s/g, ""));
  }
  const limitM = t.match(/\b(?:find|get|show)\s+(\d{1,3})\b/i);
  const seeds = [...t.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|ie|news|media|tv|es|mx|in|au|ca))\b/gi)].map((m) => m[1]!);
  const notInPipeline = /not (?:already )?in (?:our |the )?(?:pipeline|crm)|aren'?t in (?:our |the )?(?:pipeline|crm)/i.test(t);

  const kwParts = [ownership.includes("independent") ? "independent" : "", categories.join(" or ").toLowerCase(), "news site"].filter(Boolean);
  const keywords = categories.length ? [kwParts.join(" ")] : [];

  return criteriaSchema.parse({
    categories,
    countries,
    ownership,
    muuMin,
    muuMax,
    keywords,
    seedDomains: seeds,
    notInPipeline,
    limit: limitM ? Math.min(500, Number(limitM[1])) : undefined,
  });
}

/** Coerce AI output into valid criteria (drop junk rather than fail). */
export function coerceAiCriteria(raw: z.infer<typeof nlCriteriaSchema>): Criteria {
  const countries = raw.countries.map((c) => (c.toUpperCase() === "UK" ? "GB" : c.toUpperCase())).filter((c) => /^[A-Z]{2}$/.test(c));
  const res = criteriaSchema.safeParse({
    categories: raw.categories.slice(0, 20),
    countries,
    languages: raw.languages.filter((l) => /^[a-z]{2}$/i.test(l)),
    muuMin: raw.muuMin != null && raw.muuMin >= 0 ? Math.round(raw.muuMin) : null,
    muuMax: raw.muuMax != null && raw.muuMax > 0 ? Math.round(raw.muuMax) : null,
    ownership: raw.ownership,
    keywords: raw.keywords.filter((k) => k.trim().length >= 2).slice(0, 10),
    seedDomains: raw.seedDomains,
    notInPipeline: raw.notInPipeline,
    limit: raw.limit != null && raw.limit >= 1 ? Math.min(500, Math.round(raw.limit)) : undefined,
  });
  if (res.success) return res.data;
  return criteriaSchema.parse({ categories: raw.categories.slice(0, 20), countries, keywords: raw.keywords.slice(0, 10) });
}

/** Build SERP discovery queries from criteria (keyword discovery, SCOUT-1). */
export function serpQueries(c: Pick<Criteria, "keywords" | "categories" | "countries" | "ownership">, max = 3): string[] {
  const out = [...c.keywords];
  if (!out.length && c.categories.length) {
    const indie = c.ownership.includes("independent") ? "independent " : "";
    for (const cat of c.categories) out.push(`${indie}${cat.toLowerCase()} news site`);
  }
  return [...new Set(out)].slice(0, max);
}

export function describeCriteria(c: Partial<Criteria>): string {
  const parts: string[] = [];
  if (c.categories?.length) parts.push(c.categories.join(", "));
  if (c.countries?.length) parts.push(c.countries.join("+"));
  if (c.muuMin != null || c.muuMax != null) parts.push(`${c.muuMin != null ? compact(c.muuMin) : "0"}–${c.muuMax != null ? compact(c.muuMax) : "∞"} MUU`);
  if (c.ownership?.length) parts.push(c.ownership.map((o) => OWNERSHIP_LABELS[o] ?? o).join("/"));
  if (c.keywords?.length) parts.push(`"${c.keywords[0]}"${c.keywords.length > 1 ? ` +${c.keywords.length - 1}` : ""}`);
  if (c.seedDomains?.length) parts.push(`like ${c.seedDomains.slice(0, 2).join(", ")}`);
  if (c.domains?.length) parts.push(`${c.domains.length} listed domains`);
  return parts.join(" · ") || "No filters";
}

function compact(n: number) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
