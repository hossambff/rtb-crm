/** Contact seniority & name helpers. Pure (used by import, forms and tests). */

export const SENIORITIES = [
  { key: "c_level", label: "C-level / Founder" },
  { key: "vp", label: "VP / SVP" },
  { key: "director", label: "Director / Head" },
  { key: "manager", label: "Manager / Editor" },
  { key: "individual", label: "Individual contributor" },
] as const;
export type Seniority = (typeof SENIORITIES)[number]["key"];

export function seniorityLabel(key: string | null | undefined): string {
  return SENIORITIES.find((s) => s.key === key)?.label ?? "—";
}

/** Heuristic seniority from a job title. */
export function inferSeniority(title: string | null | undefined): Seniority | null {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\b(ceo|cfo|coo|cto|cmo|cro|cpo|cdo|cio|chief|founder|co-?founder|owner|president|publisher|chair(man|woman)?|partner|principal)\b/.test(t)) return "c_level";
  if (/\b(svp|evp|vp|vice president|gm|general manager)\b/.test(t)) return "vp";
  if (/\b(director|head of|head|editor[- ]in[- ]chief|executive editor|managing director)\b/.test(t)) return "director";
  if (/\b(manager|editor|lead|supervisor)\b/.test(t)) return "manager";
  return "individual";
}

/** "Mahir Zeynalov" → { first: "Mahir", last: "Zeynalov" }. */
export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

/** "andrew.weber@pagaya.com" → "Andrew Weber"; "sdesai@…" → "Sdesai". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
