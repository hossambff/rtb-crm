import { describe, expect, it } from "vitest";
import { computeHealth, type HealthInput } from "../health";
import { filledKeys, missingFields, needsReason, parseGateValue, reasonPicklist, requiredForStage } from "../gates";
import { activeFilterCount, parseBoardParams, withParam } from "../filters";
import { csvCell, toCsv } from "../csv";
import { heuristicSummary, parseStoredSummary } from "../summary-core";
import { coverageGaps, extractMentions, overrideAutoApproved, validateSplits } from "../rules";

const now = new Date("2026-09-30T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const base: HealthInput = {
  now,
  category: "open",
  createdAt: daysAgo(30),
  stageEnteredAt: daysAgo(2),
  slaDays: 10,
  lastActivityAt: daysAgo(1),
  nextStep: "Send pro forma",
  nextStepDueAt: daysAgo(-3),
  stakeholderRoles: ["decision_maker", "champion"],
  overdueTaskCount: 0,
};

describe("computeHealth", () => {
  it("healthy deal scores 100 with an on-track explanation", () => {
    const h = computeHealth(base);
    expect(h.score).toBe(100);
    expect(h.explanation).toMatch(/On track/);
  });
  it("closed deals are not scored", () => {
    expect(computeHealth({ ...base, category: "won" }).score).toBeNull();
    expect(computeHealth({ ...base, category: "lost" }).score).toBeNull();
  });
  it("penalizes stale activity relative to SLA", () => {
    expect(computeHealth({ ...base, lastActivityAt: daysAgo(7) }).score).toBe(90);
    expect(computeHealth({ ...base, lastActivityAt: daysAgo(15) }).score).toBe(80);
    expect(computeHealth({ ...base, lastActivityAt: daysAgo(25) }).score).toBe(70);
  });
  it("missing next step costs 20, a waiting reason softens it", () => {
    expect(computeHealth({ ...base, nextStep: null, nextStepDueAt: null }).score).toBe(80);
    expect(computeHealth({ ...base, nextStep: null, nextStepDueAt: null, nextStepWaitingReason: "Client until Oct 10" }).score).toBe(95);
  });
  it("overdue next step escalates with age", () => {
    expect(computeHealth({ ...base, nextStepDueAt: daysAgo(2) }).score).toBe(90);
    const h = computeHealth({ ...base, nextStepDueAt: daysAgo(6) });
    expect(h.score).toBe(80);
    expect(h.explanation).toMatch(/overdue by 6 days/);
  });
  it("stakeholder coverage, stage age and overdue tasks stack and clamp at 0", () => {
    expect(computeHealth({ ...base, stakeholderRoles: [] }).score).toBe(85);
    expect(computeHealth({ ...base, stakeholderRoles: ["champion"] }).score).toBe(92);
    expect(computeHealth({ ...base, stageEnteredAt: daysAgo(25) }).score).toBe(80);
    expect(computeHealth({ ...base, overdueTaskCount: 5 }).score).toBe(85);
    const worst = computeHealth({
      ...base,
      lastActivityAt: null,
      nextStep: null,
      nextStepDueAt: null,
      stakeholderRoles: [],
      stageEnteredAt: daysAgo(90),
      overdueTaskCount: 9,
      extraPenalties: [{ points: 40, reason: "Negative email sentiment" }],
    });
    expect(worst.score).toBe(0);
    expect(worst.factors[0]!.points).toBe(40);
  });
  it("QA-17: no activity ever → penalized by deal age vs SLA, never 'on track'", () => {
    const fresh = computeHealth({ ...base, createdAt: now, stageEnteredAt: now, lastActivityAt: null, stakeholderRoles: [] });
    expect(fresh.score).toBe(75); // 10 (no activity yet) + 15 (no stakeholders)
    expect(fresh.explanation).toMatch(/No activity logged yet/);
    expect(computeHealth({ ...base, lastActivityAt: null, createdAt: daysAgo(15), stageEnteredAt: daysAgo(2) }).score).toBe(80);
    expect(computeHealth({ ...base, lastActivityAt: null, createdAt: daysAgo(30), stageEnteredAt: daysAgo(2) }).score).toBe(70);
  });
  it("QA-17: imported deals with no activity are capped at 60 (needs review)", () => {
    const imp = computeHealth({ ...base, createdAt: daysAgo(1), stageEnteredAt: daysAgo(1), lastActivityAt: null, imported: true });
    expect(imp.score).toBe(60);
    expect(imp.explanation).toMatch(/needs review/);
    // already below the cap → unchanged; with real activity → scored normally
    expect(computeHealth({ ...base, lastActivityAt: null, stakeholderRoles: [], nextStep: null, nextStepDueAt: null, imported: true }).score).toBe(35);
    expect(computeHealth({ ...base, imported: true }).score).toBe(100);
  });
  it("uses a default SLA when the stage has none", () => {
    expect(computeHealth({ ...base, slaDays: null, lastActivityAt: daysAgo(10) }).score).toBe(90);
  });
});

describe("gates", () => {
  const contract = { requiredFields: ["muu", "primaryContactId"], category: "open" as const };
  it("open stages always require next step + due", () => {
    expect(requiredForStage(contract)).toEqual(["muu", "primaryContactId", "nextStep", "nextStepDueAt"]);
    expect(requiredForStage({ requiredFields: [], category: "won" })).toEqual([]);
  });
  it("computes missing fields from filled keys", () => {
    const filled = filledKeys({ muu: 1_000_000, primaryContactId: null, nextStep: "Call", nextStepDueAt: now, customFields: {} });
    expect(missingFields(contract, filled)).toEqual(["primaryContactId"]);
    expect(filledKeys({ muu: 0, customFields: { ndaSigned: "yes" } }, ["ndaSigned"])).toEqual(["ndaSigned"]);
  });
  it("reason rules per category", () => {
    expect(needsReason("open")).toBe(false);
    expect(needsReason("won")).toBe(true);
    expect(reasonPicklist("lost")).toBe("lost_reason");
    expect(reasonPicklist("hold")).toBe("hold_reason");
    expect(reasonPicklist("won")).toBeNull();
  });
  it("parses gate inputs into DB units", () => {
    expect(parseGateValue("usd", "$12,500.50")).toBe(1_250_050);
    expect(parseGateValue("percent", "40")).toBe(0.4);
    expect(parseGateValue("percent", "140")).toBeUndefined();
    expect(parseGateValue("number", "2,500,000")).toBe(2_500_000);
    expect(parseGateValue("number", "0")).toBeUndefined();
    expect(parseGateValue("date", "2026-10-02")).toBeInstanceOf(Date);
    expect(parseGateValue("text", "  ")).toBeUndefined();
  });
});

describe("board params", () => {
  it("parses and sanitizes URL params", () => {
    const r = parseBoardParams({ q: " polygon ", priority: "bogus", overdue: "1", lane: "owner", view: "list", status: "won" });
    expect(r.filters).toEqual({ q: "polygon", owner: undefined, priority: undefined, category: undefined, overdue: true, status: "won" });
    expect(r.lane).toBe("owner");
    expect(r.view).toBe("list");
    expect(activeFilterCount(r.filters)).toBe(3);
  });
  it("withParam sets and removes keys", () => {
    const sp = new URLSearchParams("q=a&lane=owner");
    expect(withParam(sp, "q", null)).toBe("?lane=owner");
    expect(withParam(sp, "view", "list")).toBe("?q=a&lane=owner&view=list");
  });
});

describe("csv", () => {
  it("quotes and neutralizes formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\r\n1,");
  });
});

describe("rules", () => {
  it("validates splits", () => {
    expect(validateSplits([{ userId: "a", pct: 50 }, { userId: "b", pct: 50 }])).toBeNull();
    expect(validateSplits([{ userId: "a", pct: 60 }, { userId: "b", pct: 50 }])).toMatch(/total 110%/);
    expect(validateSplits([{ userId: "a", pct: 50 }, { userId: "a", pct: 50 }])).toMatch(/once/);
    expect(validateSplits([])).toMatch(/at least one/);
  });
  it("extracts mentions by longest name", () => {
    const users = [
      { id: "1", name: "Chris" },
      { id: "2", name: "Chris Smith" },
      { id: "3", name: "Will Heckman" },
    ];
    expect(extractMentions("hey @Chris Smith and @will heckman, cc @Chrissy", users).sort()).toEqual(["2", "3"]);
    expect(extractMentions("@Chris, thoughts?", users)).toEqual(["1"]);
    expect(extractMentions("no mentions", users)).toEqual([]);
  });
  it("override approval + coverage", () => {
    expect(overrideAutoApproved("executive")).toBe(true);
    expect(overrideAutoApproved("sales_leader")).toBe(false);
    expect(coverageGaps(["decision_maker", null])).toEqual(["No champion", "No economic buyer"]);
  });
});

describe("heuristic summary", () => {
  it("builds a grounded summary from context", () => {
    const s = heuristicSummary({
      now,
      deal: { name: "NY Post", stageName: "Proposal", category: "open", daysInStage: 4, nextStep: "Send pro forma v2", nextStepDueAt: daysAgo(-2), valueLabel: "$12M gross", ownerName: "Chris" },
      activities: [{ id: "a1", type: "call", subject: "Pricing call", body: null, occurredAt: daysAgo(1), actorName: "Chris" }],
      openTasks: [
        { id: "t1", title: "Send pro forma", dueAt: daysAgo(1), owedBy: "us", evidence: "“we'll send it Friday”" },
        { id: "t2", title: "Share GA access", dueAt: null, owedBy: "them", evidence: null },
      ],
      stakeholders: [{ name: "Jane", role: "champion", title: "CRO" }],
      healthExplanation: "Next step overdue by 1 day.",
    });
    expect(s.lastTouch).toMatch(/call on 2026-09-29: Pricing call/);
    expect(s.ourCommitments).toHaveLength(1);
    expect(s.theirCommitments).toEqual(["Share GA access"]);
    expect(s.nextAction).toMatch(/overdue commitment: Send pro forma/);
    expect(s.risks).toContain("Decision maker not identified");
    expect(s.citations[0]!.ref).toBe("activity:a1");
    const stored = parseStoredSummary(JSON.stringify({ ...s, engine: "heuristic", generatedAt: now.toISOString() }));
    expect(stored && "summary" in stored && stored.engine).toBe("heuristic");
    expect(parseStoredSummary("plain markdown")).toEqual({ text: "plain markdown" });
  });
});
