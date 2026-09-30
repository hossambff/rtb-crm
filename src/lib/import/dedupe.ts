/**
 * Dedupe helpers (PRD ACC-5, IMP-5). Pure.
 * Identity: normalized domain first; fall back to a normalized name when there is no usable domain.
 */
import { normalizeDomain } from "../domain";

const NAME_STOP = /\b(the|inc|inc\.|llc|ltd|limited|plc|corp|corporation|co|company|group|holdings|n\.?v\.?|s\.?a\.?)\b/g;

/** Aggressive name key: lowercase, strip accents/punctuation/TLDs/corporate suffixes/parentheticals. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|org|net|io|co|ai|news|info|us|uk|co\.uk|in|xyz|finance|network|technology)(\/.*)?$/, " ")
    .replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  const stripped = s.replace(NAME_STOP, " ").replace(/\s+/g, "").trim();
  return stripped || s.replace(/\s+/g, "");
}

/** Dedupe key for an account-like record. */
export function accountKey(rec: { domain?: string | null; name?: string | null }): string | null {
  const d = normalizeDomain(rec.domain ?? null);
  if (d) return `d:${d}`;
  const n = normalizeName(rec.name);
  return n ? `n:${n}` : null;
}

/** "ir.applieddigital.com" → "applieddigital.com" (IR / newsroom / corporate subdomains of company websites). */
export function stripCorporateSubdomain(domain: string | null): string | null {
  if (!domain) return null;
  const stripped = domain.replace(/^(ir|investors?|news|newsroom|press|media|about|corporate|corp|global|en|us|home)\./i, "");
  return stripped.includes(".") ? stripped : domain;
}

/** "hoopsrumors.com" → "Hoopsrumors"; "cen.acs.org" → "Cen.acs". Used when a row has only a domain. */
export function nameFromDomain(domain: string): string {
  const base = domain.replace(/\.(com|org|net|io|co|ai|news|info|us|co\.uk|uk|in)$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** A cell value that is really a name, not a URL/domain ("https://www.carolinahuddle.com/" → null). */
export function cleanAccountName(name: string | null | undefined, domain: string | null): string | null {
  const s = name?.trim();
  if (!s) return domain ? nameFromDomain(domain) : null;
  const asDomain = normalizeDomain(s);
  if (asDomain && (/^https?:\/\//i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test(s))) return nameFromDomain(asDomain);
  return s.replace(/\s+/g, " ");
}

/** Sørensen–Dice coefficient on character bigrams (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** Source priority for merges (IMP-5): Strategic > Active > Pipeline > everything else. Lower = higher priority. */
export function sourcePriority(source: string | null | undefined): number {
  const s = (source ?? "").toLowerCase();
  if (/closed|platform agreement/.test(s)) return 0;
  if (/strategic/.test(s)) return 1;
  if (/active/.test(s)) return 2;
  if (/sports/.test(s)) return 3;
  if (/pipeline|master|netdev/.test(s)) return 4;
  return 5;
}

export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && !(v instanceof Date)) return Object.keys(v as object).length === 0;
  return false;
}

/**
 * Merge policy "update empty fields only": returns the subset of `incoming` that should be written onto `current`
 * (fields where current is empty and incoming is not), plus the `before` snapshot of those fields.
 */
export function fillEmpty<T extends Record<string, unknown>>(current: Partial<T>, incoming: Partial<T>): { patch: Partial<T>; before: Partial<T> } {
  const patch: Partial<T> = {};
  const before: Partial<T> = {};
  for (const [k, v] of Object.entries(incoming) as [keyof T, T[keyof T]][]) {
    if (isEmptyValue(v)) continue;
    if (isEmptyValue(current[k])) {
      patch[k] = v;
      before[k] = (current[k] ?? null) as T[keyof T];
    }
  }
  return { patch, before };
}
