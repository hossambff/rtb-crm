/**
 * Cell-level parsing helpers for spreadsheet/CSV import (PRD IMP-1/2/3). Pure — shared by the import wizard
 * (route handlers) and scripts/import-spreadsheets.ts. No server-only deps.
 */

export type CellValue = string | number | boolean | Date | null;

/** Flatten an exceljs cell value (rich text, hyperlink, formula result, error) into a primitive. */
export function cellToValue(v: unknown): CellValue {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if ("result" in o) return cellToValue(o.result);
    if ("formula" in o || "sharedFormula" in o) return null;
    if ("error" in o) return null;
    if ("text" in o) {
      const t = cellToValue(o.text);
      if (t != null && t !== "") return t;
      return typeof o.hyperlink === "string" ? o.hyperlink.replace(/^mailto:/i, "") : null;
    }
    if (typeof o.hyperlink === "string") return o.hyperlink.replace(/^mailto:/i, "");
  }
  return null;
}

/** Trimmed string or null (empty / whitespace-only / "null" → null). Dates → ISO date. */
export function cellText(v: unknown): string | null {
  const x = cellToValue(v);
  if (x == null) return null;
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  const s = String(x).replace(/ /g, " ").trim();
  return s === "" ? null : s;
}

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, embedded newlines). Auto-detects ; or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": (firstLine.match(/,/g) ?? []).length, ";": (firstLine.match(/;/g) ?? []).length, "\t": (firstLine.match(/\t/g) ?? []).length };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  const delim = best[1] > 0 ? best[0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") inQuotes = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/**
 * Section header rows inside a sheet ("── Bitcoin Mining … ──", or the same label repeated across every cell).
 * Returns the cleaned label, or null when the row is a normal data row.
 */
export function sectionLabel(cells: CellValue[]): string | null {
  const texts = cells.map((c) => cellText(c)).filter((t): t is string => t != null);
  if (texts.length === 0) return null;
  const first = texts[0]!;
  if (/^[─—–\-=]{2,}/.test(first) && /[─—–\-=]{2,}$/.test(first)) return first.replace(/^[─—–\-=\s]+|[─—–\-=\s]+$/g, "").trim() || null;
  if (texts.length >= 4 && texts.every((t) => t === first)) return first;
  return null;
}

/** "$100,000" / 100000 / "$1.2M" / "12.5k" → cents. */
export function parseMoneyToCents(v: unknown): number | null {
  const x = cellToValue(v);
  if (x == null || typeof x === "boolean" || x instanceof Date) return null;
  if (typeof x === "number") return x > 0 ? Math.round(x * 100) : null;
  const s = x.toLowerCase().replace(/[$,\s]|usd/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return null;
  const mult = m[2] === "b" ? 1e9 : m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  const n = Number(m[1]) * mult;
  return n > 0 ? Math.round(n * 100) : null;
}

/** "$937.6M" / "1.2B" / 1200000000 → USD (integer). */
export function parseMarketCapUsd(v: unknown): number | null {
  const cents = parseMoneyToCents(v);
  return cents == null ? null : Math.round(cents / 100);
}

/**
 * Loose date parser for status/notes cells: Date objects, ISO strings, "7/29", "8/4/26", "8/31/2026".
 * Month/day without a year assume `refYear` (the spreadsheets are all 2026).
 */
export function parseLooseDate(v: unknown, refYear = 2026): Date | null {
  const x = cellToValue(v);
  if (x == null || typeof x === "boolean") return null;
  if (x instanceof Date) return x;
  if (typeof x === "number") {
    // Excel serial date (days since 1899-12-30) in a plausible range
    if (x > 40000 && x < 60000) return new Date(Date.UTC(1899, 11, 30) + x * 86400000);
    return null;
  }
  const s = x.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!));
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (us) {
    const month = +us[1]!;
    const day = +us[2]!;
    let year = us[3] ? +us[3] : refYear;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return new Date(Date.UTC(year, month - 1, day));
  }
  return null;
}

export function parseBool(v: unknown): boolean | null {
  const x = cellToValue(v);
  if (x == null) return null;
  if (typeof x === "boolean") return x;
  if (typeof x === "number") return x !== 0;
  const s = String(x).trim().toLowerCase();
  if (["yes", "y", "true", "x", "✓", "✔", "1", "done"].includes(s)) return true;
  if (["no", "n", "false", "0", "-", "—"].includes(s)) return false;
  return null;
}

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export function extractEmails(v: unknown): string[] {
  const s = cellText(v);
  if (!s) return [];
  return Array.from(new Set((s.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/^mailto:/, ""))));
}

export function extractUrls(v: unknown): string[] {
  const s = cellText(v);
  if (!s) return [];
  return Array.from(new Set(s.match(/https?:\/\/[^\s,;|]+/gi) ?? []));
}

export function isUrl(s: string | null | undefined): boolean {
  return !!s && /^https?:\/\//i.test(s.trim());
}

export function isLinkedinUrl(s: string | null | undefined): boolean {
  return !!s && /linkedin\.com\//i.test(s);
}

/** Probability-like cell: 1 / 0.9 / "90%" / 90 → 0..1. */
export function parseProbability(v: unknown): number | null {
  const x = cellToValue(v);
  if (x == null || typeof x === "boolean" || x instanceof Date) return null;
  const n = typeof x === "number" ? x : Number(String(x).replace(/%/g, "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1) return n <= 100 ? n / 100 : null;
  return n;
}
