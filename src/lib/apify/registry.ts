import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { ApifyError, runActorSync, type RunOptions } from "./client";
import { mapItems, type Purpose, type Quarantined, type RecordFor } from "./mappers";
import { renderInputTemplate, type TemplateVars } from "./template";

export type RegistryActor = typeof s.actorRegistry.$inferSelect;

/**
 * Actors for a purpose in fallback order. Only enabled AND compliant actors may run (SCOUT-22:
 * public-data actors without personal logged-in cookies, compliance box ticked by an admin).
 */
export async function actorsFor(purpose: Purpose): Promise<RegistryActor[]> {
  return db
    .select()
    .from(s.actorRegistry)
    .where(and(eq(s.actorRegistry.purpose, purpose), eq(s.actorRegistry.enabled, true), eq(s.actorRegistry.compliant, true)))
    .orderBy(asc(s.actorRegistry.fallbackOrder));
}

/** Per-result cost of the primary actor for a purpose (for estimates); 0 when none is registered. */
export async function primaryCost(purpose: Purpose): Promise<{ actor: RegistryActor | null; costPerResultUsd: number }> {
  const [a] = await actorsFor(purpose);
  return { actor: a ?? null, costPerResultUsd: a?.costPerResultUsd ?? 0 };
}

export type ActorResult<P extends Purpose> = {
  actorId: string;
  records: RecordFor<P>[];
  quarantined: Quarantined[];
  itemCount: number;
  costUsd: number;
  costEstimated: boolean;
  attempts: { actorId: string; error?: string }[];
};

/**
 * Run a purpose synchronously with fallback: render the registry input template, call run-sync-get-dataset-items,
 * map + validate output. Falls back to the next actor on API errors or when every item was malformed.
 * Cost for sync runs = items × costPerResultUsd (run-sync responses don't carry usage), marked as estimated.
 */
export async function runPurposeSync<P extends Purpose>(
  token: string,
  purpose: P,
  vars: TemplateVars,
  opts: { maxItems?: number; maxChargeUsd?: number; actors?: RegistryActor[] } = {},
): Promise<ActorResult<P>> {
  const actors = opts.actors ?? (await actorsFor(purpose));
  if (!actors.length) throw new ApifyError(`No enabled, compliant actor is registered for "${purpose}".`);
  const attempts: { actorId: string; error?: string }[] = [];
  let lastErr: unknown = null;
  for (const a of actors) {
    const maxItems = Math.max(1, Math.min(opts.maxItems ?? a.maxItems, a.maxItems || 1000));
    const run: RunOptions = {
      actorId: a.actorId,
      input: renderInputTemplate(a.inputTemplate, { maxItems, ...vars }),
      timeoutSecs: a.timeoutSecs,
      maxItems,
      maxTotalChargeUsd: opts.maxChargeUsd,
    };
    try {
      const items = await runActorSync(token, run);
      const mapped = mapItems(purpose, items, a.outputMapping);
      if (items.length > 0 && mapped.records.length === 0 && actors.indexOf(a) < actors.length - 1) {
        attempts.push({ actorId: a.actorId, error: `all ${items.length} items malformed` });
        continue;
      }
      attempts.push({ actorId: a.actorId });
      return {
        actorId: a.actorId,
        records: mapped.records,
        quarantined: mapped.quarantined,
        itemCount: items.length,
        costUsd: Math.round(items.length * a.costPerResultUsd * 10000) / 10000,
        costEstimated: true,
        attempts,
      };
    } catch (e) {
      lastErr = e;
      attempts.push({ actorId: a.actorId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  throw lastErr instanceof Error ? lastErr : new ApifyError(`All actors for "${purpose}" failed.`);
}
