import { describe, expect, it } from "vitest";
import {
  composeStoryBody,
  parseBody,
  prefillStory,
  quoteInTranscript,
  reactionSummary,
  storyValue,
  toggleReaction,
  type StoryFacts,
} from "../story-core";

const facts: StoryFacts = {
  status: "won",
  dealName: "TheStreet Coalition",
  accountName: "TheStreet",
  pipelineKey: "NET",
  unit: "muu",
  valueUsd: 6_200_000,
  muu: 12_400_000,
  createdAt: new Date("2026-09-01T12:00:00Z"),
  closedAt: new Date("2026-09-25T12:00:00Z"),
  lostReason: null,
  stagePath: ["Lead", "Discovery", "Discovery", "Proposal", "Won"],
  activity: { email: 14, call: 2, meeting: 4 },
  objections: [{ objection: "We already have an ad stack", response: "Showed the 30-day migration plan and revenue guarantee" }],
  champion: "Dana Lee (CRO)",
};

describe("prefillStory", () => {
  it("builds a factual win draft", () => {
    const d = prefillStory(facts);
    expect(d.kind).toBe("win");
    expect(d.title).toBe("Won TheStreet Coalition — 12.4M MUU");
    expect(d.timeline).toBe("24 days from first entry to signature. Path: Lead → Discovery → Proposal → Won. 4 meetings, 2 calls, 14 emails.");
    expect(d.whatWorked).toBe("Champion: Dana Lee (CRO). Stayed in front of the buyer — 4 meetings. Fast cycle (24 days).");
    expect(d.objection).toBe("“We already have an ad stack” → Showed the 30-day migration plan and revenue guarantee");
  });

  it("builds a loss draft with the lost reason and no invented facts", () => {
    const d = prefillStory({ ...facts, status: "lost", lostReason: "competitor: went with Arena", objections: [], champion: null, activity: { email: 0, call: 0, meeting: 0 }, stagePath: ["Lead"] });
    expect(d.kind).toBe("loss");
    expect(d.title).toBe("Lost TheStreet Coalition — what we learned");
    expect(d.whatWorked).toBe("Lost reason: competitor: went with Arena.");
    expect(d.objection).toBe("");
    expect(d.timeline).toBe("24 days from first entry to close.");
  });

  it("formats $ motions and unknown values", () => {
    expect(storyValue({ unit: "usd", valueUsd: 180_000, muu: null })).toBe("$180K");
    expect(storyValue({ unit: "activation", valueUsd: 0, muu: null })).toBe("");
  });
});

describe("body compose/parse", () => {
  it("round-trips labelled sections and drops empty ones", () => {
    const body = composeStoryBody("win", { whatWorked: "Champion early.", objection: "", timeline: "24 days." });
    expect(body).toBe("What worked:\nChampion early.\n\nTimeline:\n24 days.");
    expect(parseBody(body)).toEqual([
      { label: "What worked", text: "Champion early." },
      { label: "Timeline", text: "24 days." },
    ]);
  });
  it("keeps free text as unlabelled blocks", () => {
    expect(parseBody("Big news: we shipped.\n\nSecond para")).toEqual([
      { label: null, text: "Big news: we shipped." },
      { label: null, text: "Second para" },
    ]);
    expect(parseBody("Note to all:\nline")).toEqual([{ label: "Note to all", text: "line" }]);
    expect(parseBody(null)).toEqual([]);
  });
});

describe("reactions", () => {
  it("toggles and prunes", () => {
    let r = toggleReaction({}, "🎉", "u1");
    r = toggleReaction(r, "🎉", "u2");
    expect(r).toEqual({ "🎉": ["u1", "u2"] });
    r = toggleReaction(r, "🎉", "u1");
    r = toggleReaction(r, "🎉", "u2");
    expect(r).toEqual({});
  });
  it("summarizes in fixed order with my state", () => {
    expect(reactionSummary({ "🔥": ["a"], "🎉": ["a", "b"], "🦄": ["x"] }, "b")).toEqual([
      { emoji: "🎉", count: 2, mine: true },
      { emoji: "🔥", count: 1, mine: false },
    ]);
  });
});

describe("quoteInTranscript", () => {
  const raw = "[00:01:02] Dana: We already have an ad stack,\n[00:01:10] Chris: Sure — and we’d migrate it in 30 days.";
  it("accepts exact and cross-line selections, rejects invented quotes", () => {
    expect(quoteInTranscript("we already have an AD stack", raw)).toBe(true);
    expect(quoteInTranscript("ad stack, Sure — and we'd migrate it", raw)).toBe(true);
    expect(quoteInTranscript("we will double your revenue", raw)).toBe(false);
    expect(quoteInTranscript("ad", raw)).toBe(false);
  });
});

describe("stripCitations", () => {
  it("removes model source tags but keeps real parentheses", async () => {
    const { stripCitations } = await import("../story-core");
    expect(stripCitations("The deal was lost due to timing (CRM).")).toBe("The deal was lost due to timing.");
    expect(stripCitations("Zero calls this week (crm_week)? What happened")).toBe("Zero calls this week? What happened");
    expect(stripCitations("Moved from Target [source: crm_deal] to Lost")).toBe("Moved from Target to Lost");
    expect(stripCitations("Dana Lee (CRO) championed it (12 meetings).")).toBe("Dana Lee (CRO) championed it (12 meetings).");
  });
});
