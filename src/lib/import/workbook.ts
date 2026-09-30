/**
 * Workbook readers (XLSX via exceljs, CSV via parseCsv) → plain cell grids. No server-only deps so the migration
 * script can use it; only ever called server-side (route handlers / scripts).
 */
import ExcelJS from "exceljs";
import { cellText, cellToValue, parseCsv, type CellValue } from "./cells";

export type SheetData = {
  name: string;
  /** rows[0] = spreadsheet row 1; cells[0] = column A. Trailing empty rows removed. */
  rows: CellValue[][];
  /** Font colors (argb) per "row:col" — only populated when requested (blue = research estimate). */
  fontColors?: Map<string, string>;
};

function worksheetToRows(ws: ExcelJS.Worksheet, withColors: boolean): SheetData {
  const rows: CellValue[][] = [];
  const fontColors = withColors ? new Map<string, string>() : undefined;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: CellValue[] = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      cells[col - 1] = cellToValue(cell.value);
      const argb = withColors ? (cell.font?.color as { argb?: string } | undefined)?.argb : undefined;
      if (argb && fontColors) fontColors.set(`${rowNumber}:${col}`, argb);
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rowNumber - 1] = cells;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  while (rows.length && !rows[rows.length - 1]!.some((c) => cellText(c) != null)) rows.pop();
  return { name: ws.name, rows, fontColors };
}

export async function readXlsx(data: ArrayBuffer | Uint8Array, opts: { withColors?: boolean } = {}): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook();
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => worksheetToRows(ws, !!opts.withColors)).filter((s) => s.rows.length > 0);
}

export async function readXlsxFile(path: string, opts: { withColors?: boolean } = {}): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.worksheets.map((ws) => worksheetToRows(ws, !!opts.withColors));
}

export function readCsvText(text: string, name = "CSV"): SheetData[] {
  return [{ name, rows: parseCsv(text) }];
}

/** Guess the header row (0-based): first of the top 15 rows with ≥3 short text cells followed by a data row. */
export function detectHeaderRow(rows: CellValue[][]): number {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const texts = (rows[i] ?? []).map((c) => cellText(c)).filter((t): t is string => !!t);
    const shortTexts = texts.filter((t) => t.length <= 60 && !/^\d+(\.\d+)?$/.test(t));
    const next = rows[i + 1] ?? [];
    if (shortTexts.length >= 3 && next.some((c) => cellText(c) != null)) return i;
  }
  return 0;
}

/** Headers + data rows for a sheet given a header row index. Empty rows are dropped; row numbers are 1-based. */
export function sheetTable(sheet: SheetData, headerRow: number) {
  const headerCells = sheet.rows[headerRow] ?? [];
  const width = Math.max(headerCells.length, ...sheet.rows.slice(headerRow + 1, headerRow + 200).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => cellText(headerCells[i] ?? null));
  const data: { rowNumber: number; cells: CellValue[] }[] = [];
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i] ?? [];
    if (!cells.some((c) => cellText(c) != null)) continue;
    data.push({ rowNumber: i + 1, cells });
  }
  return { headers, data };
}
