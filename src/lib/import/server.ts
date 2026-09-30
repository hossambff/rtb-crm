import "server-only";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { assertCan, dealModule, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { ImportEngine } from "./engine";
import { IMPORT_TARGETS, type ImportTarget, type Mapping } from "./fields";
import { normalizeRow, type NormalizedRecord } from "./normalize";
import { createStageMatcher } from "./status";
import { readCsvText, readXlsx, sheetTable, type SheetData } from "./workbook";
import { assertSheetBounds, assertUploadSize, IMPORT_LIMITS, inspectXlsxZip } from "./limits";

export const MAX_UPLOAD_BYTES = IMPORT_LIMITS.maxUploadBytes;
export const TEMPLATES_KEY = "import.templates";

export type ImportTemplate = { id: string; name: string; target: ImportTarget; pipelineKey: string | null; mapping: Mapping; createdBy: string; createdAt: string };

export async function loadTemplates(): Promise<ImportTemplate[]> {
  const v = await getSetting<ImportTemplate[] | null>(TEMPLATES_KEY, []);
  return Array.isArray(v) ? v : [];
}

/** Parse an uploaded CSV / XLSX File into sheets. Throws a user-facing Error on bad input. */
export async function parseUpload(file: File): Promise<SheetData[]> {
  // SEC M-13: size on the wire, then (xlsx) declared uncompressed size / sheets without inflating, then rows/columns.
  assertUploadSize(file.size);
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") {
    const sheets = readCsvText(await file.text(), file.name.replace(/\.csv$/i, ""));
    assertSheetBounds(sheets);
    return sheets;
  }
  if (name.endsWith(".xlsx") || file.type.includes("spreadsheetml")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    inspectXlsxZip(bytes);
    let sheets: SheetData[];
    try {
      sheets = await readXlsx(bytes);
    } catch {
      throw new Error("Couldn't read that workbook. Save it as .xlsx (Excel 2007+) or CSV and try again.");
    }
    assertSheetBounds(sheets);
    return sheets;
  }
  throw new Error("Upload a .csv or .xlsx file.");
}

export function pipelineForTarget(target: ImportTarget, pipelineKey: string | null | undefined): string {
  if (target === "r100") return "R100";
  if (target === "ads") return "ADS";
  return pipelineKey || "NET";
}

/** Permission gate for running an import into a target (IMP: import module + create on the deal pipeline). */
export async function assertCanImport(user: AppUser, target: ImportTarget, pipelineKey: string | null) {
  await assertCan(user, "import", "import");
  if (!IMPORT_TARGETS.some((t) => t.key === target)) throw new ForbiddenError("Unknown import target");
  if (target === "contacts") await assertCan(user, "contacts", "create");
  else {
    await assertCan(user, "accounts", "create");
    await assertCan(user, dealModule(pipelineForTarget(target, pipelineKey)), "create");
  }
}

export type ImportRequest = { sheet: SheetData; headerRow: number; target: ImportTarget; pipelineKey: string | null; mapping: Mapping; fileName: string };

/** Normalize every data row of the sheet with the chosen mapping (uses the pipeline's live stage aliases). */
export async function buildRecords(engine: ImportEngine, req: ImportRequest) {
  await engine.load();
  const key = pipelineForTarget(req.target, req.pipelineKey);
  const stages = engine.stagesFor(key);
  if (req.target !== "contacts" && !stages.length) throw new Error(`Pipeline ${key} has no stages`);
  const matchStatus = createStageMatcher(stages);
  const factor = await getSetting<number>("scout.visits_per_unique", 2.5);
  const { headers, data } = sheetTable(req.sheet, req.headerRow);
  const source = `${req.fileName}${req.sheet.name && req.sheet.name !== "CSV" ? ` › ${req.sheet.name}` : ""}`.slice(0, 120);
  const records: (NormalizedRecord | null)[] = data.map((r) =>
    normalizeRow(r.cells, headers, req.mapping, r.rowNumber, {
      target: req.target,
      pipelineKey: key,
      source,
      matchStatus,
      importDate: new Date(),
      visitsPerUnique: factor,
      audienceSource: `Import: ${req.fileName}`,
      audienceConfidence: "reported",
    }),
  );
  return { headers, data, records };
}

export async function listBatches(limit = 100) {
  return db
    .select({
      id: s.importBatches.id,
      fileName: s.importBatches.fileName,
      sheetName: s.importBatches.sheetName,
      target: s.importBatches.target,
      pipelineKey: s.importBatches.pipelineKey,
      status: s.importBatches.status,
      stats: s.importBatches.stats,
      createdAt: s.importBatches.createdAt,
      rolledBackAt: s.importBatches.rolledBackAt,
      createdBy: s.importBatches.createdBy,
      createdByName: s.user.name,
    })
    .from(s.importBatches)
    .leftJoin(s.user, eq(s.user.id, s.importBatches.createdBy))
    .orderBy(desc(s.importBatches.createdAt))
    .limit(limit);
}

export async function getBatchDetail(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [batch] = await db
    .select({ b: s.importBatches, createdByName: s.user.name })
    .from(s.importBatches)
    .leftJoin(s.user, eq(s.user.id, s.importBatches.createdBy))
    .where(eq(s.importBatches.id, id));
  if (!batch) return null;
  const summary = await db
    .select({ entity: s.importRecords.entity, action: s.importRecords.action, n: count() })
    .from(s.importRecords)
    .where(eq(s.importRecords.batchId, id))
    .groupBy(s.importRecords.entity, s.importRecords.action);
  const recs = await db.select().from(s.importRecords).where(and(eq(s.importRecords.batchId, id), inArray(s.importRecords.entity, ["account", "deal", "contact"]))).limit(300);
  const ids = (e: string) => recs.filter((r) => r.entity === e).map((r) => r.entityId);
  const [accs, deals, cons] = await Promise.all([
    ids("account").length ? db.select({ id: s.accounts.id, name: s.accounts.name, deleted: sql<boolean>`${s.accounts.deletedAt} is not null` }).from(s.accounts).where(inArray(s.accounts.id, ids("account"))) : [],
    ids("deal").length ? db.select({ id: s.deals.id, name: s.deals.name, deleted: sql<boolean>`${s.deals.deletedAt} is not null` }).from(s.deals).where(inArray(s.deals.id, ids("deal"))) : [],
    ids("contact").length ? db.select({ id: s.contacts.id, name: s.contacts.fullName, deleted: sql<boolean>`${s.contacts.deletedAt} is not null` }).from(s.contacts).where(inArray(s.contacts.id, ids("contact"))) : [],
  ]);
  const names = new Map([...accs, ...deals, ...cons].map((x) => [x.id, x]));
  return {
    batch: { ...batch.b, createdByName: batch.createdByName },
    summary,
    rows: recs.map((r) => ({ entity: r.entity, entityId: r.entityId, action: r.action, before: r.before, name: names.get(r.entityId)?.name ?? null, deleted: names.get(r.entityId)?.deleted ?? false })),
  };
}

/** Who may roll back a batch: import scope "all" → any; "team" → batches by team members; "own" → own batches. */
export async function assertCanRollback(user: AppUser, createdBy: string | null) {
  const scope = await assertCan(user, "import", "import");
  if (scope === "all" || scope === "pipeline") return;
  if (scope === "team" && createdBy && user.teamMemberIds.includes(createdBy)) return;
  if (scope === "own" && createdBy === user.id) return;
  throw new ForbiddenError("You can only roll back imports you (or your team) ran.");
}
