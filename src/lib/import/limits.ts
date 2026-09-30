/**
 * SEC M-13: upload limits for spreadsheet imports (and the Lead Scout domain list). Pure — unit tested.
 *
 * XLSX files are ZIP archives; exceljs inflates everything in memory, so a small crafted file (zip bomb) could exhaust
 * a function. Before handing bytes to exceljs we read the ZIP central directory (no inflation) and reject archives
 * whose declared uncompressed size, entry count, compression ratio or sheet count is out of bounds. Row caps are
 * enforced again after parsing (CSV and XLSX).
 */

export const IMPORT_LIMITS = {
  maxUploadBytes: 10 * 1024 * 1024, // 10 MB on the wire
  maxRows: 20_000, // data rows per sheet
  maxSheets: 20,
  maxColumns: 300,
  maxUncompressedBytes: 120 * 1024 * 1024, // sum of all ZIP entries once inflated
  maxEntryUncompressedBytes: 80 * 1024 * 1024,
  maxZipEntries: 2_000,
  maxCompressionRatio: 200, // per entry (uncompressed / compressed); real xlsx sheets are ~5–30×
} as const;

export type ImportLimits = { [K in keyof typeof IMPORT_LIMITS]: number };

/** Limit violations are plain Errors: the import route handlers echo plain Error messages to the user. */
const UploadLimitError = Error;

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

export function assertUploadSize(bytes: number, limits: Pick<ImportLimits, "maxUploadBytes"> = IMPORT_LIMITS) {
  if (bytes > limits.maxUploadBytes) throw new UploadLimitError(`File is larger than ${mb(limits.maxUploadBytes)}.`);
}

export type ZipSummary = { entries: number; uncompressedBytes: number; sheets: number };

/**
 * Inspect a ZIP (xlsx) archive's central directory without inflating it. Throws UploadLimitError when it is out of
 * bounds, or a plain Error when it isn't a readable ZIP.
 */
export function inspectXlsxZip(buf: Uint8Array, limits: ImportLimits = IMPORT_LIMITS): ZipSummary {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: signature 0x06054b50, within the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Couldn't read that workbook. Save it as .xlsx (Excel 2007+) or CSV and try again.");
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new UploadLimitError("That workbook is too large to import (ZIP64).");
  if (total > limits.maxZipEntries) throw new UploadLimitError("That workbook has too many parts to import.");
  if (cdOffset + cdSize > buf.byteLength) throw new Error("Couldn't read that workbook. Save it as .xlsx (Excel 2007+) or CSV and try again.");

  let p = cdOffset;
  let uncompressedBytes = 0;
  let sheets = 0;
  const decoder = new TextDecoder();
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new Error("Couldn't read that workbook. Save it as .xlsx (Excel 2007+) or CSV and try again.");
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new UploadLimitError("That workbook is too large to import (ZIP64).");
    if (uncompressed > limits.maxEntryUncompressedBytes) throw new UploadLimitError(`A sheet in that workbook expands beyond ${mb(limits.maxEntryUncompressedBytes)}. Split the file.`);
    if (uncompressed > 1024 * 1024 && uncompressed / Math.max(compressed, 1) > limits.maxCompressionRatio)
      throw new UploadLimitError("That workbook is compressed suspiciously well (possible zip bomb). Re-save it as CSV.");
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > limits.maxUncompressedBytes) throw new UploadLimitError(`That workbook expands beyond ${mb(limits.maxUncompressedBytes)}. Split the file.`);
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) sheets++;
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (sheets > limits.maxSheets) throw new UploadLimitError(`That workbook has ${sheets} sheets — the limit is ${limits.maxSheets}.`);
  return { entries: total, uncompressedBytes, sheets };
}

/** Row / column caps after parsing (CSV and XLSX). */
export function assertSheetBounds(sheets: { name: string; rows: unknown[][] }[], limits: Pick<ImportLimits, "maxRows" | "maxSheets" | "maxColumns"> = IMPORT_LIMITS) {
  if (sheets.length > limits.maxSheets) throw new UploadLimitError(`That file has ${sheets.length} sheets — the limit is ${limits.maxSheets}.`);
  for (const sh of sheets) {
    // +50 leaves room for title/header rows above the data
    if (sh.rows.length > limits.maxRows + 50) throw new UploadLimitError(`Sheet "${sh.name.slice(0, 60)}" has more than ${limits.maxRows.toLocaleString("en-US")} rows. Split the file.`);
    for (const r of sh.rows) if (r.length > limits.maxColumns) throw new UploadLimitError(`Sheet "${sh.name.slice(0, 60)}" has more than ${limits.maxColumns} columns.`);
  }
}
