import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { can, getCurrentUser } from "@/lib/rbac/server";
import { parseDomainRows, parseDomainText } from "@/lib/scout/domain-list";
import { IMPORT_LIMITS, inspectXlsxZip } from "@/lib/import/limits";

// SEC M-13: a domain list is one small sheet — much tighter inflation bounds than the import wizard.
const DOMAIN_LIST_ZIP_LIMITS = { ...IMPORT_LIMITS, maxSheets: 10, maxUncompressedBytes: 20 * 1024 * 1024, maxEntryUncompressedBytes: 15 * 1024 * 1024 };

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;

/** Upload a CSV/XLSX domain list (single column; optional 2nd column = manual MUU). Parsing only — nothing is stored. */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await can(user, "scout", "create"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const len = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > MAX_BYTES + 64 * 1024) return NextResponse.json({ error: "File is larger than 2 MB." }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File is larger than 2 MB." }, { status: 413 });
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".xlsx")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        inspectXlsxZip(bytes, DOMAIN_LIST_ZIP_LIMITS);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read that file." }, { status: 413 });
      }
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) return NextResponse.json({ error: "The workbook has no sheets." }, { status: 400 });
      const rows: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (rows.length >= MAX_ROWS) return;
        const vals = (row.values as unknown[]).slice(1, 3).map(cellText);
        rows.push(vals);
      });
      return NextResponse.json(parseDomainRows(rows));
    }
    if (name.endsWith(".csv") || name.endsWith(".txt") || file.type.startsWith("text/")) {
      const text = (await file.text()).split(/\r?\n/).slice(0, MAX_ROWS).join("\n");
      return NextResponse.json(parseDomainText(text));
    }
    return NextResponse.json({ error: "Use a .csv, .txt or .xlsx file." }, { status: 415 });
  } catch {
    return NextResponse.json({ error: "Could not read that file." }, { status: 400 });
  }
}

function cellText(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "object") {
    const o = v as { text?: unknown; hyperlink?: unknown; result?: unknown; richText?: { text: string }[] };
    if (typeof o.text === "string") return o.text;
    if (typeof o.hyperlink === "string") return o.hyperlink;
    if (o.result != null) return cellText(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
  }
  return String(v);
}
