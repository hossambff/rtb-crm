/**
 * Domain-list upload / paste parsing (SCOUT-1 "upload a domain list"). Pure — unit tested.
 * Accepts one domain per line or CSV rows; an optional second column is a manual MUU ("450k", "1.2M", 300000).
 * A header row ("domain", "website", "url", "site") is skipped.
 */
import { normalizeDomain, parseAudience } from "@/lib/domain";

export type DomainRow = { domain: string; muu: number | null };
export type DomainListResult = { rows: DomainRow[]; invalid: string[]; duplicates: number };

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if ((ch === "," || ch === "\t" || ch === ";") && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseDomainRows(rows: unknown[][]): DomainListResult {
  const seen = new Set<string>();
  const out: DomainRow[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  rows.forEach((cells, i) => {
    const first = cells[0] == null ? "" : String(cells[0]).trim();
    if (!first) return;
    if (i === 0 && /^(domain|domains|website|url|site|sites)$/i.test(first)) return;
    const d = normalizeDomain(first);
    if (!d) {
      if (invalid.length < 50) invalid.push(first.slice(0, 80));
      return;
    }
    if (seen.has(d)) {
      duplicates++;
      return;
    }
    seen.add(d);
    const muuCell = cells[1];
    out.push({ domain: d, muu: muuCell == null || muuCell === "" ? null : parseAudience(muuCell as string | number) });
  });
  return { rows: out, invalid, duplicates };
}

export function parseDomainText(text: string): DomainListResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // a single line with many comma/space separated domains (paste) → one per cell
  if (lines.filter((l) => l.trim()).length === 1 && /[\s,;]/.test(lines[0]!.trim())) {
    const tokens = lines[0]!.split(/[\s,;]+/).filter(Boolean);
    if (tokens.every((t) => !parseAudience(t) || normalizeDomain(t))) return parseDomainRows(tokens.map((t) => [t]));
  }
  return parseDomainRows(lines.map(splitCsvLine));
}
