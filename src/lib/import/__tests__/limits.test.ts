import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { assertSheetBounds, assertUploadSize, IMPORT_LIMITS, inspectXlsxZip } from "../limits";

/** Minimal ZIP with only a central directory + EOCD describing the given entries (no data needed for inspection). */
function fakeZip(entries: { name: string; compressed: number; uncompressed: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const cd: number[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint32(20, e.compressed, true);
    h.setUint32(24, e.uncompressed, true);
    h.setUint16(28, name.length, true);
    cd.push(...new Uint8Array(h.buffer), ...name);
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cd.length, true);
  eocd.setUint32(16, 0, true);
  return new Uint8Array([...cd, ...new Uint8Array(eocd.buffer)]);
}

describe("SEC M-13: upload limits", () => {
  it("rejects files over 10 MB", () => {
    expect(() => assertUploadSize(IMPORT_LIMITS.maxUploadBytes + 1)).toThrow(/10 MB/);
    expect(() => assertUploadSize(1024)).not.toThrow();
  });

  it("accepts a real workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Deals");
    ws.addRow(["Name", "Domain", "MUU"]);
    for (let i = 0; i < 50; i++) ws.addRow([`Pub ${i}`, `pub${i}.com`, 1000 * i]);
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const sum = inspectXlsxZip(buf);
    expect(sum.sheets).toBe(1);
    expect(sum.uncompressedBytes).toBeGreaterThan(0);
  });

  it("rejects zip bombs by declared size or ratio, without inflating", () => {
    expect(() => inspectXlsxZip(fakeZip([{ name: "xl/worksheets/sheet1.xml", compressed: 50_000, uncompressed: 500 * 1024 * 1024 }]))).toThrow(/expands beyond/);
    expect(() => inspectXlsxZip(fakeZip([{ name: "xl/worksheets/sheet1.xml", compressed: 10_000, uncompressed: 40 * 1024 * 1024 }]))).toThrow(/zip bomb/);
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, compressed: 1000, uncompressed: 5000 }));
    expect(() => inspectXlsxZip(fakeZip(many))).toThrow(/sheets/);
  });

  it("rejects non-zip bytes", () => {
    expect(() => inspectXlsxZip(new TextEncoder().encode("not a zip at all, just some text"))).toThrow(/Couldn't read/);
  });

  it("caps rows and columns after parsing", () => {
    const rows = Array.from({ length: IMPORT_LIMITS.maxRows + 51 }, () => ["a"]);
    expect(() => assertSheetBounds([{ name: "Big", rows }])).toThrow(/20,000 rows/);
    expect(() => assertSheetBounds([{ name: "Wide", rows: [Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, () => "x")] }])).toThrow(/columns/);
    expect(() => assertSheetBounds([{ name: "Ok", rows: [["a", "b"]] }])).not.toThrow();
  });
});
