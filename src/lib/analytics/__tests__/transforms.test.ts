import { describe, expect, it } from "vitest";
import {
  classifyMove,
  commitmentsKept,
  concentration,
  cumulative,
  funnelFromFlags,
  healthBand,
  hygieneScore,
  isPlausibleEmail,
  pctChange,
  percentile,
  pivot,
  stageConversion,
  topNWithOther,
  unmappedFromStats,
  winRate,
  ytdMonths,
} from "../transforms";
import { basisLabel, filtersToQuery, parseFilters, rangeStart } from "../filters";

const now = new Date("2026-09-30T15:00:00Z");

describe("filters", () => {
  it("defaults to 30 days, gross, incl. overrides", () => {
    const f = parseFilters({}, now);
    expect(f.range).toBe("30d");
    expect(f.basis).toBe("gross");
    expect(f.overrides).toBe(true);
    expect(f.pipeline).toBeNull();
    expect(f.from.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });
  it("parses params and rejects junk", () => {
    const f = parseFilters({ range: "ytd", pipeline: "NET", owner: "abc-123", basis: "net", overrides: "excl" }, now);
    expect(f).toMatchObject({ range: "ytd", pipeline: "NET", owner: "abc-123", basis: "net", overrides: false });
    expect(f.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const bad = parseFilters({ range: "1y", pipeline: "NET'; drop", owner: "x y", basis: "weird" }, now);
    expect(bad).toMatchObject({ range: "30d", pipeline: null, owner: null, basis: "gross" });
  });
  it("round-trips to a query string omitting defaults", () => {
    const f = parseFilters({ range: "90d", basis: "net" }, now);
    expect(filtersToQuery(f)).toBe("?range=90d&basis=net");
    expect(filtersToQuery(f, { basis: null, pipeline: "SPT" })).toBe("?range=90d&pipeline=SPT");
    expect(filtersToQuery(parseFilters({}, now))).toBe("");
  });
  it("labels the basis", () => {
    expect(basisLabel({ basis: "net", overrides: false })).toBe("RTB net basis · excl. manual overrides");
  });
  it("computes range starts", () => {
    expect(rangeStart("7d", now).toISOString()).toBe("2026-09-23T15:00:00.000Z");
  });
});

describe("concentration", () => {
  it("returns top-5 share of the total", () => {
    const r = concentration([50, 20, 10, 10, 5, 5, 0, -3]);
    expect(r.total).toBe(100);
    expect(r.top).toBe(95);
    expect(r.share).toBeCloseTo(0.95);
  });
  it("handles empty input", () => {
    expect(concentration([]).share).toBeNull();
  });
});

describe("classifyMove", () => {
  const open = (sortOrder: number) => ({ sortOrder, category: "open" as const });
  it("forward/back/won/lost/hold", () => {
    expect(classifyMove(open(1), open(3))).toBe("advanced");
    expect(classifyMove(open(3), open(1))).toBe("slipped");
    expect(classifyMove(open(3), { sortOrder: 8, category: "won" })).toBe("advanced");
    expect(classifyMove(open(3), { sortOrder: 11, category: "lost" })).toBe("slipped");
    expect(classifyMove(open(3), { sortOrder: 9, category: "hold" })).toBe("slipped");
    expect(classifyMove({ sortOrder: 9, category: "hold" }, open(3))).toBe("advanced");
    expect(classifyMove(null, open(0))).toBe("lateral");
    expect(classifyMove(open(2), open(2))).toBe("lateral");
    // cold/nurture sorts after the funnel but is not progress
    expect(classifyMove(open(0), { sortOrder: 12, category: "open", nurture: true })).toBe("slipped");
    expect(classifyMove({ sortOrder: 12, category: "open", nurture: true }, open(2))).toBe("advanced");
  });
});

describe("hygieneScore", () => {
  it("counts deals with a next step due today or later", () => {
    const deals = [
      { nextStep: "Send deck", nextStepDueAt: new Date("2026-10-02") },
      { nextStep: "Call", nextStepDueAt: new Date("2026-09-01") }, // overdue
      { nextStep: null, nextStepDueAt: new Date("2026-10-02") },
      { nextStep: "  ", nextStepDueAt: new Date("2026-10-02") },
    ];
    expect(hygieneScore(deals, now)).toBe(0.25);
    expect(hygieneScore([], now)).toBeNull();
  });
});

describe("commitmentsKept", () => {
  it("counts on-time completions of commitments that came due", () => {
    const r = commitmentsKept(
      [
        { status: "done", dueAt: "2026-09-20T12:00:00Z", completedAt: "2026-09-19T12:00:00Z" }, // kept
        { status: "done", dueAt: "2026-09-20T12:00:00Z", completedAt: "2026-09-25T12:00:00Z" }, // late
        { status: "open", dueAt: "2026-09-21T12:00:00Z", completedAt: null }, // missed
        { status: "open", dueAt: "2026-10-05T12:00:00Z", completedAt: null }, // not yet due
        { status: "cancelled", dueAt: "2026-09-10T12:00:00Z", completedAt: null }, // excluded
        { status: "done", dueAt: "2026-10-09T12:00:00Z", completedAt: "2026-09-29T12:00:00Z" }, // done early → counts
        { status: "open", dueAt: null, completedAt: null },
      ],
      now,
    );
    expect(r).toEqual({ kept: 2, due: 4, rate: 0.5 });
  });
});

describe("winRate / pctChange / percentile", () => {
  it("works", () => {
    expect(winRate(3, 1)).toBe(0.75);
    expect(winRate(0, 0)).toBeNull();
    expect(pctChange(120, 100)).toBeCloseTo(0.2);
    expect(pctChange(5, 0)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("stageConversion", () => {
  const stages = [
    { id: "a", name: "Target", sortOrder: 0 },
    { id: "b", name: "Outreach", sortOrder: 1 },
    { id: "c", name: "Hot", sortOrder: 4 },
  ];
  it("computes reached counts and next-stage conversion", () => {
    const r = stageConversion(stages, [
      { maxOpenOrder: 0, won: false },
      { maxOpenOrder: 1, won: false },
      { maxOpenOrder: 4, won: false },
      { maxOpenOrder: 4, won: true },
      { maxOpenOrder: null, won: true }, // imported straight into won
    ]);
    expect(r.map((s) => s.reached)).toEqual([5, 4, 3]);
    expect(r[0]!.conversion).toBeCloseTo(0.8);
    expect(r[2]!.nextLabel).toBe("Won");
    expect(r[2]!.conversion).toBeCloseTo(2 / 3);
  });
});

describe("funnelFromFlags", () => {
  it("propagates later steps backwards so the funnel is monotonic", () => {
    expect(
      funnelFromFlags(
        [
          [true, false, false, false],
          [true, true, false, false],
          [false, false, false, true], // qualified without logged touches → counts in every step
          [false, false, false, false],
        ],
        4,
      ),
    ).toEqual([3, 2, 1, 1]);
  });
});

describe("healthBand", () => {
  it("bands scores", () => {
    expect(healthBand(85)).toBe("good");
    expect(healthBand(55)).toBe("warning");
    expect(healthBand(30)).toBe("serious");
    expect(healthBand(2)).toBe("critical");
    expect(healthBand(null)).toBe("unscored");
  });
});

describe("pivot / topNWithOther", () => {
  it("pivots long rows into wide rows with zero-filled series", () => {
    const rows = [
      { tier: "90%", motion: "NET", v: 10 },
      { tier: "90%", motion: "ENT", v: 5 },
      { tier: "50%", motion: "NET", v: 2 },
      { tier: "50%", motion: "CUSTOM1", v: 1 },
    ];
    expect(pivot(rows, "tier", "motion", "v", ["NET", "ENT"])).toEqual([
      { tier: "90%", NET: 10, ENT: 5 },
      { tier: "50%", NET: 2, Other: 1, ENT: 0 },
    ]);
  });
  it("folds the tail into Other", () => {
    const r = topNWithOther(
      [
        { k: "a", v: 1 },
        { k: "b", v: 5 },
        { k: "c", v: 3 },
        { k: "d", v: 2 },
      ],
      2,
      "k",
      "v",
    );
    expect(r).toEqual([
      { k: "b", v: 5 },
      { k: "c", v: 3 },
      { k: "Other", v: 3 },
    ]);
  });
});

describe("misc", () => {
  it("validates emails pragmatically", () => {
    expect(isPlausibleEmail("jane@nypost.com")).toBe(true);
    expect(isPlausibleEmail("jane.doe+x@sub.example.co.uk")).toBe(true);
    expect(isPlausibleEmail("jane@")).toBe(false);
    expect(isPlausibleEmail("jane at nypost.com")).toBe(false);
    expect(isPlausibleEmail("Chris/Will")).toBe(false);
    expect(isPlausibleEmail(null)).toBe(false);
  });
  it("builds YTD months and cumulative series", () => {
    expect(ytdMonths(new Date("2026-03-15T00:00:00Z"))).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(cumulative(["2026-01", "2026-02", "2026-03"], [{ bucket: "2026-01", value: 2 }, { bucket: "2026-03", value: 1 }])).toEqual([2, 2, 3]);
  });
  it("reads unmapped status counts from import stats", () => {
    expect(unmappedFromStats({ created: 10, unmappedStatuses: 4 })).toBe(4);
    expect(unmappedFromStats({ unmapped: 2 })).toBe(2);
    expect(unmappedFromStats({ created: 1 })).toBe(0);
    expect(unmappedFromStats(null)).toBe(0);
  });
});
