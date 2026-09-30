import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { ImportEngine } from "@/lib/import/engine";
import { assertCanImport, buildRecords, pipelineForTarget } from "@/lib/import/server";
import { authed, errorResponse, json, readImportForm } from "../shared";

/** Commit an import (IMP-1/5/6): one import_batches row, row-level import_records with `before`, audited. */
export async function POST(req: Request) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  try {
    const input = await readImportForm(req);
    await assertCanImport(user, input.target, input.pipelineKey);
    const engine = new ImportEngine(db, { actorId: user.id });
    const { records } = await buildRecords(engine, input);
    engine.beginBatch({
      fileName: input.fileName,
      sheetName: input.sheet.name,
      target: input.target,
      pipelineKey: pipelineForTarget(input.target, input.pipelineKey),
      mapping: input.mapping,
    });
    for (const rec of records) {
      if (!rec) {
        engine.stats.rows++;
        engine.stats.skipped++;
        continue;
      }
      // owners resolve to existing users by first name, else a banned placeholder user an admin can claim later
      engine.apply(rec);
    }
    const res = await engine.flush(); // writes import_batches, import_records and the audit_log entry
    revalidatePath("/accounts");
    revalidatePath("/contacts");
    revalidatePath("/import");
    return json({ batchId: res.batchId, stats: res.stats, unmapped: res.unmapped });
  } catch (e) {
    return errorResponse(e);
  }
}
