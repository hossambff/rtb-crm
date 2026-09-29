import "server-only";
import { db } from "@/db";
import { claims } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { findClaimHits, type ClaimRule, type ClaimHit } from "./claims-core";

export type { ClaimHit };

/** PRD §11.5 claim guardrail: check outgoing text (emails, proposals, AI drafts) against the claim library. */
export async function checkClaims(text: string): Promise<{ mode: "warn" | "block"; hits: ClaimHit[]; blocked: boolean }> {
  const rules = (await db.select().from(claims)) as ClaimRule[];
  const mode = await getSetting<"warn" | "block">("agent.claims_mode", "warn");
  const hits = findClaimHits(text, rules);
  return { mode, hits, blocked: mode === "block" && hits.some((h) => h.status === "banned") };
}
