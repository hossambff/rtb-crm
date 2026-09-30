import { NextResponse } from "next/server";
import { assertCan } from "@/lib/rbac/server";
import { cellText } from "@/lib/import/cells";
import { IMPORT_TARGETS, columnIds, suggestMapping } from "@/lib/import/fields";
import { loadTemplates, parseUpload } from "@/lib/import/server";
import { detectHeaderRow, sheetTable } from "@/lib/import/workbook";
import { authed, errorResponse, json } from "../shared";

/** Step 1 of the wizard: read the upload, list sheets, detect header rows, suggest mappings per target. */
export async function POST(req: Request) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  try {
    await assertCan(user, "import", "import");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "Attach a .csv or .xlsx file." }, 400);
    const sheets = await parseUpload(file);
    if (!sheets.length) return json({ error: "The file has no data." }, 400);
    const templates = await loadTemplates();
    // optional override: re-read one sheet with a user-chosen header row (0-based)
    const overrideSheet = String(form.get("sheet") ?? "");
    const overrideRow = Number(form.get("headerRow"));
    return json({
      fileName: file.name,
      sheets: sheets.map((sh) => {
        const headerRow = sh.name === overrideSheet && Number.isInteger(overrideRow) && overrideRow >= 0 && overrideRow < 50 ? overrideRow : detectHeaderRow(sh.rows);
        const { headers, data } = sheetTable(sh, headerRow);
        return {
          name: sh.name,
          headerRow,
          rowCount: data.length,
          headers: columnIds(headers),
          sample: data.slice(0, 5).map((r) => headers.map((_, i) => (cellText(r.cells[i] ?? null) ?? "").slice(0, 80))),
          suggested: Object.fromEntries(IMPORT_TARGETS.map((t) => [t.key, suggestMapping(headers, t.key)])),
        };
      }),
      templates,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
