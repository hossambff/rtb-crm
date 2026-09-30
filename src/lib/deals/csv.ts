/** Minimal RFC-4180 CSV builder with spreadsheet formula-injection protection. Pure. */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralize formula injection (=, +, -, @, tab, CR) for spreadsheet apps — but keep plain negative numbers.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
}
