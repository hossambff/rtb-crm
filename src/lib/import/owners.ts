/**
 * Owner normalization (PRD IMP-4). Pure.
 * "Chris/Will" → equal split; typos ("Caey", "chris") mapped; unknown reps become placeholder users
 * (`<first>.placeholder@roundtable.invalid`, banned, role viewer) that an admin later claims for a real user.
 */
import { splitOwners } from "../domain";

export type EmploymentType = "staff" | "retainer" | "hourly" | "commission" | "contractor";

/** Known spreadsheet reps (C&W "Team" tab + rep columns). First name is the matching key. */
export const KNOWN_REPS: Record<string, { fullName: string; employmentType: EmploymentType | null; title?: string }> = {
  Chris: { fullName: "Chris Smith", employmentType: "retainer", title: "SVP Strategic Partnerships" },
  Will: { fullName: "Will Heckman", employmentType: "retainer", title: "SVP Sales" },
  Kevin: { fullName: "Kevin Glaittli", employmentType: "hourly", title: "Intern" },
  Andres: { fullName: "Andres Simbeck", employmentType: "hourly", title: "Intern" },
  Casey: { fullName: "Casey Bohrer", employmentType: "hourly", title: "Intern" },
  Erik: { fullName: "Erik Lew", employmentType: "commission", title: "Commission-only sales" },
  Ben: { fullName: "Ben Johnson", employmentType: "commission", title: "Commission-only sales" },
  Mariah: { fullName: "Mariah Crom", employmentType: "commission", title: "Commission-only sales" },
  Daniel: { fullName: "Daniel Alecio", employmentType: "commission", title: "Commission-only sales" },
  Kade: { fullName: "Kade", employmentType: null },
  Yousef: { fullName: "Yousef", employmentType: null },
  Mehab: { fullName: "Mehab", employmentType: null },
  SW: { fullName: "SW", employmentType: null },
  Liz: { fullName: "Liz", employmentType: null },
};

const TYPOS: Record<string, string> = { caey: "Casey", casy: "Casey", andrés: "Andres", andre: "Andres", kev: "Kevin", sw: "SW", chirs: "Chris", eric: "Erik" };

/** Canonical first-name token for a rep, or null when the token is not a plausible person name. */
export function canonicalRep(token: string): string | null {
  const t = token.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const first = t.split(" ")[0]!;
  const lower = first.toLowerCase();
  if (TYPOS[lower]) return TYPOS[lower]!;
  if (!/^[a-zà-ÿ]{2,12}$/i.test(first)) return null;
  // Full names ("Chris Smith") → known rep by full name
  for (const [k, v] of Object.entries(KNOWN_REPS)) if (v.fullName.toLowerCase() === t.toLowerCase()) return k;
  if (lower.length <= 2) return first.toUpperCase();
  const canon = lower.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return canon[0]!.toUpperCase() + canon.slice(1);
}

/** Parse an owner cell into canonical rep first names (deduplicated, order kept). */
export function parseOwners(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = String(raw);
  if (s.length > 60) return []; // notes pasted into the owner column
  const out: string[] = [];
  for (const tok of splitOwners(s)) {
    const c = canonicalRep(tok);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export function placeholderEmail(first: string): string {
  return `${first.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "")}.placeholder@roundtable.invalid`;
}

export function placeholderName(first: string): string {
  return `${first} (placeholder)`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(".placeholder@roundtable.invalid");
}

/** Equal split percentages summing to exactly 100 (two decimals). */
export function equalSplits<T>(owners: T[]): { owner: T; pct: number }[] {
  if (owners.length === 0) return [];
  const base = Math.floor((100 / owners.length) * 100) / 100;
  const out = owners.map((owner) => ({ owner, pct: base }));
  const rest = Math.round((100 - base * owners.length) * 100) / 100;
  out[out.length - 1]!.pct = Math.round((out[out.length - 1]!.pct + rest) * 100) / 100;
  return out;
}

/** Match a rep first name against existing (non-placeholder) users by first name, case-insensitive. */
export function matchUserByFirstName<U extends { id: string; name: string; email: string }>(first: string, users: U[]): U | null {
  const f = first.toLowerCase();
  const real = users.filter((u) => !isPlaceholderEmail(u.email) && !u.email.startsWith("dev."));
  const hits = real.filter((u) => (u.name.split(/\s+/)[0] ?? "").toLowerCase() === f);
  if (hits.length === 1) return hits[0]!;
  const known = KNOWN_REPS[first];
  if (known) {
    const full = real.find((u) => u.name.toLowerCase() === known.fullName.toLowerCase());
    if (full) return full;
  }
  return users.find((u) => u.email === placeholderEmail(first)) ?? null;
}
