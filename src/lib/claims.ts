import "server-only";
import { db } from "@/db";
import { claims } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { findClaimHits, type ClaimRule, type ClaimHit } from "./claims-core";

export type { ClaimHit };
export type ClaimCheck = { mode: "warn" | "block"; hits: ClaimHit[]; blocked: boolean };
export type LoadedClaimRules = { rules: ClaimRule[]; mode: "warn" | "block" };

/** Load the claim library + mode once (e.g. at the start of a Copilot request) for synchronous checks later. */
export async function loadClaimRules(): Promise<LoadedClaimRules> {
  const rules = (await db.select().from(claims)) as ClaimRule[];
  const mode = await getSetting<"warn" | "block">("agent.claims_mode", "warn");
  return { rules, mode: mode === "block" ? "block" : "warn" };
}

export function checkClaimsWith(text: string, loaded: LoadedClaimRules): ClaimCheck {
  const hits = findClaimHits(text, loaded.rules);
  return { mode: loaded.mode, hits, blocked: loaded.mode === "block" && hits.some((h) => h.status === "banned") };
}

/** PRD §11.5 claim guardrail: check outgoing text (emails, proposals, AI drafts) against the claim library. */
export async function checkClaims(text: string): Promise<ClaimCheck> {
  return checkClaimsWith(text, await loadClaimRules());
}
