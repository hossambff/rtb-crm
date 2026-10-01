/**
 * Revenue-share tier tables (pure, unit tested). The numbers always come from the uploaded document (parsed here,
 * then reviewed by an admin) — never from code.
 *
 * A tier table is a table whose rows have an audience band in one cell (">60M", "20M–60M", "<50k", "1M to 5M",
 * "Up to 250K", "10M+") and two percentages in other cells (partner share and Roundtable share).
 */

export type Tier = {
  label: string;
  /** Lower bound in monthly users (null = no lower bound). */
  min: number | null;
  /** Upper bound (null = no upper bound). */
  max: number | null;
  /** ">X" excludes X itself. */
  minExclusive?: boolean;
  /** "<X" excludes X itself; ranges "A–B" and "up to B" include B. */
  maxExclusive?: boolean;
  /** Percent 0..100 of revenue to the partner. */
  partnerPct: number;
  /** Percent 0..100 of revenue to Roundtable. */
  rtbPct: number;
};

export type TierTable = { index: number; title: string; headers: string[]; tiers: Tier[]; columnsGuessed: boolean };

const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

/** "60M" → 60_000_000, "1.5 million" → 1_500_000, "50k" → 50_000, "250,000" → 250_000. */
export function parseAmount(s: string): number | null {
  const m = /^\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|mm|mn|m|million|bn|b|billion)?\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? UNIT[m[2].toLowerCase()]! : 1;
  return Math.round(n * mult);
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|mm|mn|m|million|bn|b|billion)?`;

/** Parse an audience band. Returns null for anything that does not look like one. */
export function parseBand(raw: string): Omit<Tier, "label" | "partnerPct" | "rtbPct"> | null {
  if (raw.length > 80) return null; // a band is short; also keeps the regexes below linear in practice
  const s = raw
    .replace(/ /g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/^tier\s*[\w]+\s*[:.)-]\s*/i, "")
    .replace(/\b(monthly|unique|web|users?|muu|mau|visitors?|readers?|audience|uniques)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || /%/.test(s)) return null;
  const amt = (n: string, u?: string) => parseAmount(`${n}${u ? ` ${u}` : ""}`);
  let m: RegExpExecArray | null;
  // range "A - B" / "A to B" / "between A and B"
  if ((m = new RegExp(`^(?:between\\s+)?${NUM}\\s*(?:-|to|and)\\s*${NUM}$`, "i").exec(s))) {
    let lo = amt(m[1]!, m[2]);
    const hi = amt(m[3]!, m[4]);
    // "20-60M": the unit on the upper bound applies to both
    if (lo !== null && !m[2] && m[4]) lo = amt(m[1]!, m[4]);
    if (lo === null || hi === null || lo >= hi) return null;
    return { min: lo, max: hi };
  }
  if ((m = new RegExp(`^(?:>|over|more than|above|greater than)\\s*${NUM}$`, "i").exec(s))) {
    const v = amt(m[1]!, m[2]);
    return v === null ? null : { min: v, max: null, minExclusive: true };
  }
  if ((m = new RegExp(`^(?:>=|≥|at least|min(?:imum)?)\\s*${NUM}$`, "i").exec(s)) || (m = new RegExp(`^${NUM}\\s*(?:\\+|or more|and (?:above|up|over))$`, "i").exec(s))) {
    const v = amt(m[1]!, m[2]);
    return v === null ? null : { min: v, max: null };
  }
  if ((m = new RegExp(`^(?:<|under|less than|below|fewer than)\\s*${NUM}$`, "i").exec(s))) {
    const v = amt(m[1]!, m[2]);
    return v === null ? null : { min: null, max: v, maxExclusive: true };
  }
  if ((m = new RegExp(`^(?:<=|≤|up to|max(?:imum)?)\\s*${NUM}$`, "i").exec(s))) {
    const v = amt(m[1]!, m[2]);
    return v === null ? null : { min: null, max: v };
  }
  return null;
}

/** Percentages in a cell: "50%" → [50]; "70% / 30%" → [70, 30]; a bare "70/30" split → [70, 30]. */
export function parsePercents(cell: string): number[] {
  if (cell.length > 200) return [];
  const out = [...cell.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  if (out.length) return out.filter((n) => n >= 0 && n <= 100);
  const split = /^\s*(\d{1,3}(?:\.\d+)?)\s*\/\s*(\d{1,3}(?:\.\d+)?)\s*$/.exec(cell);
  if (split) {
    const a = Number(split[1]);
    const b = Number(split[2]);
    if (a <= 100 && b <= 100 && Math.abs(a + b - 100) < 0.01) return [a, b];
  }
  return [];
}

const RTB_HEADER = /\b(roundtable|rtb)\b/i;
const PARTNER_HEADER = /\b(partner|publisher|member|you|your|client|site)\b/i;

/** Parse a table (rows of cell texts) into tiers, or null when it is not a tier table (needs ≥ 2 tier rows). */
export function parseTierTable(rows: string[][], index = 0, title = ""): TierTable | null {
  const tiers: Tier[] = [];
  let headers: string[] = [];
  let partnerFirst: boolean | null = null;
  let columnsGuessed = true;
  for (const row of rows) {
    const bandIdx = row.findIndex((c) => parseBand(c) !== null);
    if (bandIdx === -1) {
      if (!tiers.length) headers = row;
      continue;
    }
    const band = parseBand(row[bandIdx]!)!;
    const pcts: { col: number; v: number }[] = [];
    row.forEach((c, ci) => {
      if (ci === bandIdx) return;
      for (const v of parsePercents(c)) pcts.push({ col: ci, v });
    });
    if (pcts.length < 2) continue;
    const [a, b] = pcts;
    if (partnerFirst === null) {
      const ha = headers[a!.col] ?? "";
      const hb = headers[b!.col] ?? "";
      if (RTB_HEADER.test(ha) && !RTB_HEADER.test(hb)) [partnerFirst, columnsGuessed] = [false, false];
      else if (RTB_HEADER.test(hb) || PARTNER_HEADER.test(ha)) [partnerFirst, columnsGuessed] = [true, false];
      else partnerFirst = true;
    }
    tiers.push({ label: row[bandIdx]!.replace(/\s+/g, " ").trim().slice(0, 60), ...band, partnerPct: partnerFirst ? a!.v : b!.v, rtbPct: partnerFirst ? b!.v : a!.v });
  }
  if (tiers.length < 2) return null;
  return { index, title, headers: headers.map((h) => h.slice(0, 80)), tiers, columnsGuessed };
}

/** Does `muu` fall inside the tier's band? */
export function inTier(t: Tier, muu: number): boolean {
  if (t.min !== null && (t.minExclusive ? muu <= t.min : muu < t.min)) return false;
  if (t.max !== null && (t.maxExclusive ? muu >= t.max : muu > t.max)) return false;
  return true;
}

/** Index of the tier that applies to `muu`: among matching bands, the one with the highest lower bound. */
export function lookupTier(tiers: Tier[], muu: number | null | undefined): number | null {
  if (muu === null || muu === undefined || !Number.isFinite(muu) || muu < 0) return null;
  let best: number | null = null;
  tiers.forEach((t, i) => {
    if (!inTier(t, muu)) return;
    if (best === null) best = i;
    else {
      const cur = tiers[best]!.min ?? -Infinity;
      if ((t.min ?? -Infinity) > cur) best = i;
    }
  });
  return best;
}

/** Validate admin-edited tiers. Returns error messages (empty = valid). */
export function validateTiers(tiers: Tier[]): string[] {
  const errs: string[] = [];
  tiers.forEach((t, i) => {
    const n = `Row ${i + 1}`;
    if (!t.label.trim()) errs.push(`${n}: add a label.`);
    if (t.min === null && t.max === null) errs.push(`${n}: set a lower or upper bound.`);
    if (t.min !== null && t.max !== null && t.min >= t.max) errs.push(`${n}: the lower bound must be below the upper bound.`);
    for (const v of [t.min, t.max]) if (v !== null && (!Number.isFinite(v) || v < 0)) errs.push(`${n}: bounds must be positive numbers.`);
    for (const v of [t.partnerPct, t.rtbPct]) if (!Number.isFinite(v) || v < 0 || v > 100) errs.push(`${n}: percentages must be between 0 and 100.`);
  });
  return errs;
}

/** Human band text from bounds (used when an admin edits numbers). */
export function bandText(t: Pick<Tier, "min" | "max" | "minExclusive" | "maxExclusive">): string {
  const f = (v: number) => (v >= 1e9 ? `${+(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(2)}K` : String(v));
  if (t.min !== null && t.max !== null) return `${f(t.min)}–${f(t.max)}`;
  if (t.min !== null) return `${t.minExclusive ? ">" : "≥"}${f(t.min)}`;
  if (t.max !== null) return `${t.maxExclusive ? "<" : "≤"}${f(t.max)}`;
  return "Any";
}
