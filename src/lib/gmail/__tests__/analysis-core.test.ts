import { describe, expect, it } from "vitest";
import { emailAnalysisAiSchema, extractCommitments, heuristicEmailAnalysis, normalizeAiEmailAnalysis } from "../analysis-core";
import { parseGmailMessage, stripQuoted } from "../parse";
import { inboundMultipart, oooMessage } from "./fixtures";

const sentAt = new Date("2026-09-30T14:00:00Z"); // Wednesday

describe("heuristicEmailAnalysis", () => {
  const p = parseGmailMessage(inboundMultipart);
  const input = { text: stripQuoted(p.bodyText), subject: p.subject, direction: "inbound" as const, fromName: p.fromName, fromEmail: p.from, sentAt };
  const a = heuristicEmailAnalysis(input);

  it("classifies intent and awaiting-reply", () => {
    expect(a.intent).toBe("legal");
    expect(a.awaiting_reply_from).toBe("us");
    expect(a.engine).toBe("heuristic");
  });
  it("extracts their commitment with a due date and our requested action", () => {
    const theirs = a.commitments.find((c) => c.by === "them");
    expect(theirs?.text).toContain("I'll send the signed NDA by Friday");
    expect(theirs?.person).toBe("Jane Doe");
    expect(theirs?.due?.slice(0, 10)).toBe("2026-10-02");
    const ours = a.commitments.find((c) => c.by === "us");
    expect(ours?.evidence).toContain("Could you send over the pricing deck?");
  });
  it("does not pick up quoted history", () => {
    expect(a.commitments.some((c) => c.text.includes("pro forma"))).toBe(false);
  });
  it("detects progress signals and suggests (not applies) a stage", () => {
    expect(a.progress_signals.map((s) => s.type)).toEqual(expect.arrayContaining(["legal_review", "pricing_requested"]));
    expect(a.suggested_stage.stage).toBe("Contract");
    expect(a.suggested_stage.confidence).toBeGreaterThan(0);
  });
});

describe("heuristic edge cases", () => {
  it("OOO has no commitments and no reply owed", () => {
    const a = heuristicEmailAnalysis({ ...oooMessage, direction: "inbound", fromName: null, fromEmail: "x@y.com", sentAt });
    expect(a.intent).toBe("ooo");
    expect(a.commitments).toEqual([]);
    expect(a.awaiting_reply_from).toBe("none");
  });
  it("outbound: our commitments; they owe the reply", () => {
    const a = heuristicEmailAnalysis({
      text: "Great speaking today. We'll send the proposal tomorrow and I will follow up with references next week.",
      subject: "Next steps",
      direction: "outbound",
      fromName: "Rep",
      fromEmail: "rep@roundtable.io",
      sentAt,
    });
    expect(a.awaiting_reply_from).toBe("them");
    expect(a.commitments.every((c) => c.by === "us")).toBe(true);
    expect(a.commitments[0]!.due?.slice(0, 10)).toBe("2026-10-01");
    expect(a.sentiment).toBeGreaterThan(0);
  });
  it("not interested → risk flag", () => {
    const a = heuristicEmailAnalysis({ text: "Thanks, but we're not interested at this time.", subject: null, direction: "inbound", fromName: null, fromEmail: null, sentAt });
    expect(a.intent).toBe("not_interested");
    expect(a.risk_flags[0]).toMatch(/no interest/);
  });
  it("commitment extractor ignores plain statements", () => {
    expect(extractCommitments({ text: "The weather is nice. Our traffic grew 10%.", subject: null, direction: "inbound", fromName: null, fromEmail: null, sentAt })).toEqual([]);
  });
});

describe("normalizeAiEmailAnalysis", () => {
  it("keeps grounded commitments, clamps numbers, resolves due dates", () => {
    const ai = emailAnalysisAiSchema.parse({
      intent: "legal",
      awaiting_reply_from: "us",
      commitments: [
        { by: "them", person: "Jane", text: "Send signed NDA", due: null, evidence: "I'll send the signed NDA by Friday." },
        { by: "us", person: "Rep", text: "Invented", due: "2026-10-10", evidence: "This quote is not in the email" },
      ],
      progress_signals: [{ type: "legal_review", evidence: "Our legal team is reviewing the MSA." }],
      suggested_stage: { stage: "Contract", confidence: 7, reason: "legal" },
      sentiment: 3,
      risk_flags: [],
    });
    const text = "Thanks for the call. I'll send the signed NDA by Friday. Our legal team is reviewing the MSA.";
    const n = normalizeAiEmailAnalysis(ai, { text, subject: null, direction: "inbound", fromName: null, fromEmail: null, sentAt }, "google/gemini-2.5-flash");
    expect(n.commitments).toHaveLength(1);
    expect(n.commitments[0]!.due?.slice(0, 10)).toBe("2026-10-02");
    expect(n.suggested_stage.confidence).toBe(1);
    expect(n.sentiment).toBe(1);
    expect(n.engine).toBe("ai:google/gemini-2.5-flash");
  });
});
