import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { checkClaims } from "@/lib/claims";
import { safeErrorMessage } from "@/lib/integrations/core";
import { dealStageNames } from "@/lib/integrations/directory";
import {
  heuristicTranscriptAnalysis,
  normalizeAiTranscriptAnalysis,
  transcriptAnalysisAiSchema,
  transcriptAnalysisPrompt,
  type TranscriptAnalysis,
  type TranscriptContext,
} from "./analysis-core";

/**
 * CALL-6 post-call processing: strong-tier AI with heuristic fallback. Stores analysis + analysisEngine and sets
 * status ready | failed. The follow-up draft is run through the claims guardrail (§11.5) before it is shown.
 */
export async function analyzeTranscript(id: string): Promise<TranscriptAnalysis | null> {
  const [t] = await db.select().from(s.transcripts).where(eq(s.transcripts.id, id));
  if (!t) return null;
  await db.update(s.transcripts).set({ status: "processing", error: null }).where(eq(s.transcripts.id, id));
  try {
    const [owner] = t.uploadedBy ? await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(eq(s.user.id, t.uploadedBy)) : [];
    const [acct] = t.accountId ? await db.select({ name: s.accounts.name }).from(s.accounts).where(eq(s.accounts.id, t.accountId)) : [];
    const ctx: TranscriptContext = {
      title: t.title,
      occurredAt: t.occurredAt ?? t.createdAt,
      ourNames: owner ? [owner.name] : [],
      ownerName: owner?.name ?? "RTB",
      accountName: acct?.name ?? null,
      stageNames: await dealStageNames(t.dealId),
    };
    let analysis: TranscriptAnalysis | null = null;
    if (aiAvailable() && t.rawText.trim().length > 40) {
      try {
        const model = await modelFor("strong");
        const ai = await aiObject({
          kind: "transcript_analysis",
          userId: t.uploadedBy,
          tier: "strong",
          schema: transcriptAnalysisAiSchema,
          prompt: transcriptAnalysisPrompt(ctx, untrusted("transcript", t.rawText, 120_000)),
        });
        analysis = normalizeAiTranscriptAnalysis(ai, t.rawText, ctx, model);
      } catch {
        analysis = null; // logged in agent_runs; fall back
      }
    }
    analysis ??= heuristicTranscriptAnalysis(t.rawText, ctx);
    const draft = analysis.follow_up_email_draft;
    const claims = await checkClaims(`${draft.subject}\n${draft.body}`);
    analysis.follow_up_email_draft = { ...draft, claims_check: claims.hits.length ? "flagged" : "pass" };
    await db
      .update(s.transcripts)
      .set({
        analysis: { ...analysis, analyzedAt: new Date().toISOString() } as unknown as Record<string, unknown>,
        analysisEngine: analysis.engine,
        status: "ready",
        error: null,
      })
      .where(eq(s.transcripts.id, id));
    return analysis;
  } catch (e) {
    await db.update(s.transcripts).set({ status: "failed", error: safeErrorMessage(e) }).where(eq(s.transcripts.id, id));
    return null;
  }
}
