import { NextResponse } from "next/server";
import { db } from "@/db";
import { ImportEngine } from "@/lib/import/engine";
import { cellText } from "@/lib/import/cells";
import { columnIds } from "@/lib/import/fields";
import { assertCanImport, buildRecords, pipelineForTarget } from "@/lib/import/server";
import { authed, errorResponse, json, readImportForm } from "../shared";

/**
 * Wizard preview (IMP-1): validate + dedupe the whole sheet against the live CRM without writing anything.
 * Returns batch-level stats and the first 50 rows with their outcome (create / update / merge) and issues.
 */
export async function POST(req: Request) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  try {
    const input = await readImportForm(req);
    await assertCanImport(user, input.target, input.pipelineKey);
    const engine = new ImportEngine(db, { actorId: user.id });
    const { headers, data, records } = await buildRecords(engine, input);
    engine.beginBatch({ fileName: input.fileName, sheetName: input.sheet.name, target: input.target, pipelineKey: pipelineForTarget(input.target, input.pipelineKey) });
    const ids = columnIds(headers);
    const mappedIdx = ids.map((id, i) => (input.mapping[id] ? i : -1)).filter((i) => i >= 0);
    const rows: unknown[] = [];
    let errors = 0;
    records.forEach((rec, i) => {
      const outcome = rec ? engine.apply(rec) : null;
      if (!rec) errors++;
      if (rows.length < 50)
        rows.push({
          rowNumber: data[i]!.rowNumber,
          cells: mappedIdx.map((j) => ({ column: ids[j], field: input.mapping[ids[j]!], value: (cellText(data[i]!.cells[j] ?? null) ?? "").slice(0, 120) })),
          outcome,
          account: rec ? { name: rec.account.name, domain: rec.account.domain } : null,
          deal: rec?.deal ? { stageKey: outcome?.stageKey ?? rec.deal.stageKey, owners: rec.deal.owners, muu: rec.deal.muu, statusRaw: rec.deal.statusRaw } : null,
          audience: rec?.audience ?? [],
          contacts: rec?.contacts.map((c) => ({ fullName: c.fullName, email: c.email, title: c.title ?? null })) ?? [],
          notes: rec?.activities.length ?? 0,
          issues: rec ? rec.issues : [{ level: "error", field: "account.name", message: "No account name or domain — row skipped" }],
        });
    });
    const { stats, unmapped } = await engine.flush({ dryRun: true });
    return json({ totalRows: data.length, skipped: errors, stats, unmapped, rows, stages: engine.stagesFor(pipelineForTarget(input.target, input.pipelineKey)).map((s) => ({ key: s.key, name: s.name })) });
  } catch (e) {
    return errorResponse(e);
  }
}
