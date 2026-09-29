/** Pure helpers shared by import, scout, email capture. No server-only deps (unit tested). */

/** Normalize a URL/domain: strip protocol, www., path, port, trailing dot; lowercase. Returns null if not a domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  // take first token if multiple ("federalnewsnetwork.com / WTOP")
  s = s.split(/[\s,;|]+/)[0]!;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#]/)[0]!;
  s = s.replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\d?\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/** Email → domain (lowercased). */
export function emailDomain(email: string | null | undefined): string | null {
  const d = email?.split("@")[1];
  return d ? normalizeDomain(d) : null;
}

/**
 * Parse audience strings from the spreadsheets (PRD IMP-2):
 * '450k' → 450000; '1.5–2M' → 1750000 (midpoint); '100M+' → 100000000; '<100k' → 50000; '243.6K' → 243600;
 * numbers pass through; 'N/A', '—', '' → null.
 */
export function parseAudience(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  let s = String(input).trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
  if (!s || ["n/a", "na", "—", "-", "–", "tbd", "?"].includes(s)) return null;
  const lessThan = s.startsWith("<");
  s = s.replace(/^[<>~≈]+/, "").replace(/\+$/, "");
  const unit = (u: string | undefined) => (u === "b" ? 1e9 : u === "m" ? 1e6 : u === "k" ? 1e3 : 1);
  const range = s.match(/^(\d+(?:\.\d+)?)([kmb])?[–—-](\d+(?:\.\d+)?)([kmb])?/);
  if (range) {
    const hiUnit = unit(range[4]);
    const loUnit = range[2] ? unit(range[2]) : hiUnit;
    return Math.round((Number(range[1]) * loUnit + Number(range[3]) * hiUnit) / 2);
  }
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?/);
  if (!m) return null;
  const value = Number(m[1]) * unit(m[2]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(lessThan ? value / 2 : value);
}

/** Split combined owner strings ("Chris/Will", "Erik (linkedin)/Andres (email)") into clean first names. */
export function splitOwners(input: string | null | undefined): string[] {
  if (!input) return [];
  return String(input)
    .split(/[\/&,+]| and /i)
    .map((p) => p.replace(/\(.*?\)/g, "").trim())
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase());
}

/** Looks like a date / email / note rather than a status value (PRD IMP-3). */
export function classifyStatusValue(v: unknown): "status" | "date" | "email" | "url" | "note" | "empty" {
  if (v == null || v === "") return "empty";
  if (v instanceof Date) return "date";
  const s = String(v).trim();
  if (!s) return "empty";
  if (/^\S+@\S+\.\S+$/.test(s)) return "email";
  if (/^https?:\/\//i.test(s)) return "url";
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(s)) return "date";
  if (s.split(/\s+/).length > 4) return "note";
  return "status";
}

/** Weighted revenue for MUU motions: MUU × $/MUU × probability (annual, gross). */
export function muuPipelineValue(muu: number | null | undefined, usdPerMuu: number, probability: number) {
  const gross = (muu ?? 0) * usdPerMuu;
  return { gross, weighted: gross * probability };
}
