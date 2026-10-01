import { describe, expect, it } from "vitest";
import {
  applyLabel,
  applyMode,
  candidateFromStageSuggestion,
  closeDateMoves,
  detectSignalsHeuristic,
  followUpTaskTitle,
  forwardStages,
  prospectText,
  reconcile,
  resolveCloseDate,
  signalsFromEmail,
  signalsFromTranscript,
  signalUrgency,
  type SignalContext,
  type StageLite,
} from "../core";

const STAGES: StageLite[] = [
  { id: "s-target", name: "Target", category: "open", sortOrder: 1 },
  { id: "s-comms", name: "In Comms", category: "open", sortOrder: 2 },
  { id: "s-nda", name: "NDA", category: "open", sortOrder: 3 },
  { id: "s-proposal", name: "Proposal / Pro Forma", category: "open", sortOrder: 4 },
  { id: "s-neg", name: "Negotiation", category: "open", sortOrder: 5 },
  { id: "s-contract", name: "Contract", category: "open", sortOrder: 6 },
  { id: "s-won", name: "Signed (Won)", category: "won", sortOrder: 7 },
  { id: "s-hold", name: "On Hold", category: "hold", sortOrder: 8 },
  { id: "s-cold", name: "Cold / Nurture", category: "open", sortOrder: 9 },
  { id: "s-lost", name: "Lost", category: "lost", sortOrder: 10 },
];
const REF = new Date("2026-10-01T15:00:00Z"); // Q4
const ctx = (over: Partial<SignalContext> = {}): SignalContext => ({ stages: STAGES, currentStageId: "s-comms", ref: REF, expectedCloseDate: null, ...over });
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind).sort();

describe("phrase library", () => {
  it("detects an advance to Contract from 'send the contract' / legal", () => {
    const a = detectSignalsHeuristic("Thanks Alex. Can you send over the contract? I'm looping in our legal team today.", ctx());
    const adv = a.find((x) => x.kind === "advance")!;
    expect(adv.suggestedStageId).toBe("s-contract");
    expect(adv.engine).toBe("heuristic");
    expect(adv.quote).toMatch(/contract|legal/);
  });
  it("'let's sign' → contract; 'let's move forward' → next stage", () => {
    expect(detectSignalsHeuristic("Great, let's sign this week.", ctx()).find((x) => x.kind === "advance")?.suggestedStageId).toBe("s-contract");
    expect(detectSignalsHeuristic("We are happy to move forward.", ctx()).find((x) => x.kind === "advance")?.suggestedStageId).toBe("s-nda");
  });
  it("never suggests a backwards or same-stage advance", () => {
    expect(detectSignalsHeuristic("Please send the contract.", ctx({ currentStageId: "s-contract" })).filter((x) => x.kind === "advance")).toEqual([]);
    expect(detectSignalsHeuristic("Please send the NDA.", ctx({ currentStageId: "s-neg" })).filter((x) => x.kind === "advance")).toEqual([]);
  });
  it("revives a held deal only toward a named stage", () => {
    expect(detectSignalsHeuristic("We're happy to move forward.", ctx({ currentStageId: "s-hold" })).find((x) => x.kind === "advance")).toBeUndefined();
    expect(detectSignalsHeuristic("Please send over the contract.", ctx({ currentStageId: "s-hold" })).find((x) => x.kind === "advance")?.suggestedStageId).toBe("s-contract");
  });
  it("skips parking-lot stages when advancing", () => {
    expect(forwardStages(ctx({ currentStageId: "s-contract" })).map((s) => s.id)).toEqual([]);
  });
  it("detects stall and suggests the hold stage", () => {
    const a = detectSignalsHeuristic("Honestly this is not a priority for us right now.", ctx());
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "stall", suggestedStageId: "s-hold" });
  });
  it("detects risks (budget freeze, competing vendors, stakeholder change)", () => {
    expect(kinds(detectSignalsHeuristic("We have a budget freeze until further notice.", ctx()))).toEqual(["risk"]);
    expect(kinds(detectSignalsHeuristic("We're also evaluating other vendors.", ctx()))).toEqual(["risk"]);
    expect(kinds(detectSignalsHeuristic("FYI our CMO left the company last week.", ctx()))).toEqual(["risk"]);
  });
  it("detects lost and suppresses contradictory advance/stall", () => {
    const a = detectSignalsHeuristic("After review we went with another vendor. It's not a priority to revisit. Send the contract anyway.", ctx());
    expect(kinds(a)).toEqual(["lost"]);
    expect(a[0]!.suggestedStageId).toBe("s-lost");
  });
  it("detects won only for completed facts", () => {
    expect(kinds(detectSignalsHeuristic("The contract is fully executed — welcome aboard!", ctx({ currentStageId: "s-contract" })))).toEqual(["won"]);
    const promise = detectSignalsHeuristic("We will sign the contract next week.", ctx());
    expect(promise.find((x) => x.kind === "won")).toBeUndefined();
    expect(promise.find((x) => x.kind === "advance")?.suggestedStageId).toBe("s-contract");
    expect(detectSignalsHeuristic("Have you signed the contract?", ctx()).find((x) => x.kind === "won")).toBeUndefined();
  });
  it("ignores conditional phrasing", () => {
    expect(detectSignalsHeuristic("If we decide not to proceed, we'll tell you.", ctx()).find((x) => x.kind === "lost")).toBeUndefined();
  });
  it("returns nothing for neutral text", () => {
    expect(detectSignalsHeuristic("Thanks for the note, talk soon.", ctx())).toEqual([]);
  });
  it("does not flag a deal already on hold as stalling again", () => {
    expect(detectSignalsHeuristic("This is on hold for now.", ctx({ currentStageId: "s-hold" })).find((x) => x.kind === "stall")).toBeUndefined();
  });
});

describe("close dates", () => {
  it("resolves next quarter / after the holidays / next year with a timing cue", () => {
    expect(resolveCloseDate("We can revisit this next quarter.", REF)?.date.toISOString()).toBe("2027-03-31T17:00:00.000Z");
    expect(resolveCloseDate("Let's pick this back up after the holidays.", REF)?.date.toISOString()).toBe("2027-01-15T17:00:00.000Z");
    expect(resolveCloseDate("Budget decision is early next year.", REF)?.date.toISOString()).toBe("2027-02-15T17:00:00.000Z");
    expect(resolveCloseDate("We'd sign in Q1.", REF)?.date.toISOString()).toBe("2027-03-31T17:00:00.000Z");
    expect(resolveCloseDate("We need to push it back to March.", REF)?.date.toISOString()).toBe("2027-03-31T17:00:00.000Z");
  });
  it("ignores timing without a deal cue, and 'after the holidays' outside Q4/Jan", () => {
    expect(resolveCloseDate("Traffic grew a lot last quarter and should next quarter too.", REF)).toBeNull();
    expect(resolveCloseDate("Let's revisit after the holidays.", new Date("2026-05-01T00:00:00Z"))).toBeNull();
  });
  it("only emits a close-date signal when the date moves by > 14 days", () => {
    expect(closeDateMoves(new Date("2027-03-31"), new Date("2027-03-25"))).toBe(false);
    expect(closeDateMoves(new Date("2027-03-31"), null)).toBe(true);
    const c = detectSignalsHeuristic("We should revisit this next quarter.", ctx({ expectedCloseDate: new Date("2026-12-31T17:00:00Z") }));
    expect(c.find((x) => x.kind === "close_date")?.suggestedCloseDate?.toISOString()).toBe("2027-03-31T17:00:00.000Z");
    expect(detectSignalsHeuristic("We should revisit this next quarter.", ctx({ expectedCloseDate: new Date("2027-03-30T00:00:00Z") })).find((x) => x.kind === "close_date")).toBeUndefined();
  });
});

describe("AI adapters", () => {
  it("maps an AI stage suggestion to advance/won/lost/stall and drops weak or backwards ones", () => {
    expect(candidateFromStageSuggestion({ stage: "Contract", confidence: 0.8, reason: "Asked for paper" }, ctx(), "ai:m", null)).toMatchObject({ kind: "advance", suggestedStageId: "s-contract", engine: "ai:m" });
    expect(candidateFromStageSuggestion({ stage: "Lost", confidence: 0.9, reason: "x" }, ctx(), "ai:m", null)?.kind).toBe("lost");
    expect(candidateFromStageSuggestion({ stage: "On Hold", confidence: 0.7, reason: "x" }, ctx(), "ai:m", null)?.kind).toBe("stall");
    expect(candidateFromStageSuggestion({ stage: "Contract", confidence: 0.3, reason: "x" }, ctx(), "ai:m", null)).toBeNull();
    expect(candidateFromStageSuggestion({ stage: "Target", confidence: 0.9, reason: "x" }, ctx(), "ai:m", null)).toBeNull();
    expect(candidateFromStageSuggestion({ stage: "Nonexistent", confidence: 0.9, reason: "x" }, ctx(), "ai:m", null)).toBeNull();
  });
  it("email: uses AI progress signals only for AI engines", () => {
    const analysis = { engine: "ai:gemini", suggested_stage: { stage: null, confidence: 0, reason: "" }, progress_signals: [{ type: "legal_review", evidence: "legal has it" }] };
    expect(signalsFromEmail("legal has it", analysis, ctx()).find((x) => x.kind === "advance")?.engine).toBe("ai:gemini");
    expect(signalsFromEmail("legal has it", { ...analysis, engine: "heuristic" }, ctx())).toEqual([]);
  });
  it("transcript: only prospect lines feed stall/lost detection", () => {
    const raw = ["[00:00:01] Alex Rep: If it's not a priority, we can pause.", "[00:00:05] Jane Doe: Sounds good, please send the contract."].join("\n");
    expect(prospectText(raw, ["Alex Rep"])).not.toMatch(/priority/);
    const out = signalsFromTranscript(raw, ["Alex Rep"], { engine: "heuristic", suggested_stage: { stage: "Contract", confidence: 0.5, reason: "" } }, ctx());
    expect(kinds(out)).toEqual(["advance"]);
  });
  it("reconcile keeps the strongest candidate per kind and drops low confidence", () => {
    const base = { quote: null, rationale: "", engine: "heuristic", suggestedStageId: "s-nda", suggestedCloseDate: null };
    const r = reconcile([
      { ...base, kind: "advance", confidence: 0.55 },
      { ...base, kind: "advance", confidence: 0.7, suggestedStageId: "s-contract" },
      { ...base, kind: "risk", confidence: 0.3 },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.suggestedStageId).toBe("s-contract");
  });
});

describe("presentation", () => {
  it("apply modes and labels", () => {
    expect(applyMode("risk", null)).toBe("task");
    expect(applyMode("stall", null)).toBe("task");
    expect(applyMode("stall", "s-hold")).toBe("stage");
    expect(applyMode("close_date", null)).toBe("close_date");
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(applyLabel("advance", "Contract", null, fmt)).toBe("Move to Contract");
    expect(applyLabel("lost", "Lost", null, fmt)).toBe("Mark lost (Lost)");
    expect(applyLabel("close_date", null, new Date("2027-03-31T00:00:00Z"), fmt)).toBe("Set close to 2027-03-31");
    expect(applyLabel("risk", null, null, fmt)).toBe("Create follow-up task");
  });
  it("urgency ordering and task titles", () => {
    expect(signalUrgency("lost", 0.7)).toBeGreaterThan(signalUrgency("advance", 0.7));
    expect(signalUrgency("advance", 1)).toBeLessThanOrEqual(90);
    expect(followUpTaskTitle("risk", "Reach", "Budget risk — address it")).toBe("Address risk: Reach (Budget risk)");
  });
});
