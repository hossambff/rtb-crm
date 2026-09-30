import { describe, expect, it } from "vitest";
import { findTimestamp, heuristicTranscriptAnalysis, normalizeAiTranscriptAnalysis, transcriptAnalysisAiSchema } from "../analysis-core";

const TEXT = [
  "[00:00:01] Alex Rep: Thanks for joining today, Jane. Let's walk through where you are with the platform.",
  "[00:00:40] Jane Doe: We have about 2.5 million monthly uniques, mostly finance readers on WordPress with Mediavine ads.",
  "[00:01:30] Jane Doe: Our biggest pain is that ad revenue has been declining every quarter and the site is slow.",
  "[00:02:10] Jane Doe: Honestly I'm worried about losing editorial control if we migrate.",
  "[00:02:30] Alex Rep: You keep full editorial control, and our team handles the migration end to end.",
  "[00:03:00] Jane Doe: Our CEO will need to approve any revenue share split before we sign.",
  "[00:03:40] Alex Rep: I'll send the pro forma and the NDA by Friday.",
  "[00:04:05] Jane Doe: We'll review it with our CEO next week and get back to you.",
  "[00:04:30] Alex Rep: Great, we agreed to target a decision by the end of the quarter.",
].join("\n");

const ctx = { title: "Reach x RTB intro", occurredAt: new Date("2026-09-30T15:00:00Z"), ourNames: ["Alex Rep"], ownerName: "Alex Rep", accountName: "Reach" };

describe("heuristicTranscriptAnalysis", () => {
  const a = heuristicTranscriptAnalysis(TEXT, ctx);

  it("extracts action items with owners, due dates and timestamps", () => {
    const ours = a.action_items.find((x) => x.task.includes("pro forma"));
    expect(ours).toMatchObject({ owner: "us", timestamp: "00:03:40" });
    expect(ours?.due?.slice(0, 10)).toBe("2026-10-02");
    const theirs = a.action_items.find((x) => x.task.includes("review it with our CEO"));
    expect(theirs).toMatchObject({ owner: "them", timestamp: "00:04:05" });
    expect(theirs?.due?.slice(0, 10)).toBe("2026-10-05");
  });
  it("qualification, competitors, objections, decisions", () => {
    expect(a.qualification.muu_confirmed).toBe(2_500_000);
    expect(a.qualification.current_stack).toEqual(expect.arrayContaining(["WordPress", "Mediavine"]));
    expect(a.competitors).toContain("Mediavine");
    expect(a.qualification.pain.length).toBeGreaterThan(0);
    expect(a.qualification.decision_maker).toMatch(/CEO/);
    expect(a.qualification.rev_share_appetite).toMatch(/revenue share/);
    expect(a.qualification.timeline).toMatch(/end of the quarter/);
    expect(a.objections[0]?.objection).toMatch(/editorial control/);
    expect(a.objections[0]?.response_given).toMatch(/full editorial control/);
    expect(a.objections[0]?.recommended_rebuttal).toMatch(/editorial control/);
    expect(a.decisions[0]).toMatch(/we agreed/);
  });
  it("field updates, summary, follow-up draft", () => {
    expect(a.field_updates.find((f) => f.field === "muu")?.value).toBe("2500000");
    expect(a.field_updates.find((f) => f.field === "next_step")?.value).toMatch(/pro forma/);
    expect(a.summary.length).toBeGreaterThan(0);
    expect(a.summary.length).toBeLessThanOrEqual(5);
    expect(a.follow_up_email_draft.subject).toBe("Recap: Reach x RTB intro");
    expect(a.follow_up_email_draft.body).toContain("On our side:");
    expect(a.follow_up_email_draft.body).toContain("On your side:");
    expect(a.engine).toBe("heuristic");
  });
  it("handles empty transcripts", () => {
    const e = heuristicTranscriptAnalysis("", ctx);
    expect(e.action_items).toEqual([]);
    expect(e.summary[0]).toMatch(/too short/);
  });
});

describe("normalizeAiTranscriptAnalysis", () => {
  it("filters ungrounded field updates and disallowed fields; fills timestamps", () => {
    const ai = transcriptAnalysisAiSchema.parse({
      summary: ["a", "b"],
      decisions: [],
      action_items: [{ owner: "us", task: "Send pro forma", due: null, evidence: "I'll send the pro forma and the NDA by Friday.", timestamp: null }],
      objections: [],
      qualification: {
        muu_confirmed: 2500000.4,
        decision_maker: null,
        current_stack: [],
        pain: [],
        timeline: null,
        rev_share_appetite: null,
        nda_status: null,
        migration_complexity: null,
      },
      competitors: [],
      risks: [],
      sentiment: -4,
      suggested_stage: { stage: null, confidence: 0.2, reason: "" },
      field_updates: [
        { field: "muu", value: "2500000", evidence: "We have about 2.5 million monthly uniques" },
        { field: "revSharePct", value: "0.5", evidence: "We have about 2.5 million monthly uniques" },
        { field: "muu", value: "9", evidence: "made up quote" },
      ],
      follow_up_email_draft: { subject: "s", body: "b" },
    });
    const n = normalizeAiTranscriptAnalysis(ai, TEXT, ctx, "openai/gpt-5-mini");
    expect(n.field_updates).toHaveLength(1);
    expect(n.action_items[0]).toMatchObject({ id: "a1", timestamp: "00:03:40" });
    expect(n.action_items[0]!.due?.slice(0, 10)).toBe("2026-10-02");
    expect(n.qualification.muu_confirmed).toBe(2500000);
    expect(n.sentiment).toBe(-1);
    expect(n.follow_up_email_draft.claims_check).toBe("unchecked");
  });
  it("QA-11: a relative phrase in the quote wins over the model's date guess", () => {
    const ai = transcriptAnalysisAiSchema.parse({
      summary: ["a"],
      decisions: [],
      action_items: [{ owner: "them", task: "Review with CEO", due: "2026-10-02", evidence: "We'll review it with our CEO next week and get back to you.", timestamp: null }],
      objections: [],
      qualification: { muu_confirmed: null, decision_maker: null, current_stack: [], pain: [], timeline: null, rev_share_appetite: null, nda_status: null, migration_complexity: null },
      competitors: [],
      risks: [],
      sentiment: 0,
      suggested_stage: { stage: null, confidence: 0, reason: "" },
      field_updates: [],
      follow_up_email_draft: { subject: "s", body: "b" },
    });
    const n = normalizeAiTranscriptAnalysis(ai, TEXT, ctx, "openai/gpt-5-mini");
    expect(n.action_items[0]!.due?.slice(0, 10)).toBe("2026-10-05"); // Monday of next week, not this Friday
  });
  it("findTimestamp", () => {
    expect(findTimestamp(TEXT, "our CEO will need to approve")).toBe("00:03:00");
    expect(findTimestamp(TEXT, "nope nope")).toBeNull();
  });
});
