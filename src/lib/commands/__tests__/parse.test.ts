import { describe, expect, it } from "vitest";
import { looksLikeCommand, matchUser, normalizeTag, parseCommand, rankEntries, resolveCloseDate, resolveStageTarget, type Vocab } from "../parse";
import { commandSchema, describeFilter } from "../types";

const V: Vocab = {
  meId: "u-me",
  pipelines: [
    { key: "NET", name: "Network Development" },
    { key: "ENT", name: "Enterprise" },
    { key: "SPT", name: "Sports" },
    { key: "R100", name: "Roundtable 100" },
    { key: "ADS", name: "TheStreet Ads" },
    { key: "PAY", name: "Payments" },
  ],
  stages: [
    { pipelineKey: "NET", key: "outreach", name: "Outreach", category: "open" },
    { pipelineKey: "NET", key: "proposal", name: "Proposal Sent", category: "open" },
    { pipelineKey: "NET", key: "nurture", name: "Nurture", category: "hold" },
    { pipelineKey: "NET", key: "won", name: "Migrating", category: "won" },
    { pipelineKey: "NET", key: "lost", name: "Lost", category: "lost" },
    { pipelineKey: "ENT", key: "proposal", name: "Proposal Sent", category: "open" },
    { pipelineKey: "ENT", key: "lost", name: "Closed Lost", category: "lost" },
  ],
  users: [
    { id: "u-me", name: "Hossam Hamdy" },
    { id: "u-will", name: "Will Turner" },
    { id: "u-chris", name: "Chris Lee" },
    { id: "u-chris2", name: "Chris Park" },
    { id: "u-erik", name: "Erik (placeholder)" },
  ],
  selection: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
};

describe("parseCommand", () => {
  it("spec example: move idle NET deals to Nurture", () => {
    const r = parseCommand("move all NET deals idle more than 30 days to Nurture", V);
    expect(r.command).toEqual({ verb: "move", filter: { idleDays: 30, pipelineKeys: ["NET"] }, toStage: "Nurture" });
    expect(r.leftovers).toEqual([]);
    expect(commandSchema.safeParse(r.command).success).toBe(true);
  });
  it("spec example: assign these leads to Will (selection)", () => {
    const r = parseCommand("assign these 40 leads to Will", V);
    expect(r.command).toEqual({ verb: "assign", filter: { ids: V.selection }, toUser: "Will" });
    expect(r.leftovers).toEqual([]);
  });
  it("'these' without a selection matches nothing (never 'all deals')", () => {
    const r = parseCommand("assign these leads to Will", { ...V, selection: [] });
    expect(r.command?.filter.ids).toEqual([]);
  });
  it("stage + owner + hygiene filters", () => {
    const r = parseCommand("move my deals in Proposal Sent with no next step to Nurture", V);
    expect(r.command).toEqual({ verb: "move", filter: { owner: "me", noNextStep: true, stageNames: ["Proposal Sent"] }, toStage: "Nurture" });
    const o = parseCommand("reassign Chris Lee's overdue ENT deals to me", V);
    expect(o.command).toEqual({ verb: "assign", filter: { overdue: true, owner: "u-chris", pipelineKeys: ["ENT"] }, toUser: "me" });
  });
  it("idle phrasing variants", () => {
    expect(parseCommand("show deals with no activity in 2 weeks", V).command?.filter.idleDays).toBe(14);
    expect(parseCommand("show deals not touched for over 3 months", V).command?.filter.idleDays).toBe(90);
    expect(parseCommand("show 45 days idle Sports deals", V).command?.filter).toEqual({ idleDays: 45, pipelineKeys: ["SPT"] });
  });
  it("mark as lost / won", () => {
    const r = parseCommand("mark unassigned NET deals idle 90 days as lost", V);
    expect(r.command).toEqual({ verb: "move", filter: { idleDays: 90, owner: "none", pipelineKeys: ["NET"] }, toStage: "lost" });
  });
  it("tag and enroll", () => {
    expect(parseCommand("tag my top 10 ENT deals as Q4 push", V).command).toEqual({ verb: "tag", filter: { owner: "me", priority: "top10", pipelineKeys: ["ENT"] }, tag: "q4-push" });
    expect(parseCommand("add tag renewal to deals tagged vip", V).command).toEqual({ verb: "tag", filter: { tag: "vip" }, tag: "renewal" });
    expect(parseCommand("enroll selected deals in Q4 Publisher Outreach sequence", V).command).toEqual({ verb: "enroll", filter: { ids: V.selection }, sequence: "Q4 Publisher Outreach" });
  });
  it("ambiguous pipeline keys only in caps or before 'deals'", () => {
    expect(parseCommand("show ADS deals", V).command?.filter.pipelineKeys).toEqual(["ADS"]);
    expect(parseCommand("show ads deals", V).command?.filter.pipelineKeys).toEqual(["ADS"]);
    expect(parseCommand("show deals that pay well", V).command?.filter.pipelineKeys).toBeUndefined();
    expect(parseCommand("show enterprise deals with health below 40", V).command?.filter).toEqual({ healthBelow: 40, pipelineKeys: ["ENT"] });
  });
  it("leftovers signal an unparsed phrase (→ AI)", () => {
    const r = parseCommand("move deals where the CEO left the company to Nurture", V);
    expect(r.command?.verb).toBe("move");
    expect(r.leftovers).toEqual(expect.arrayContaining(["ceo", "left", "company"]));
  });
  it("non-commands", () => {
    expect(parseCommand("Reach", V).command).toBeNull();
    expect(looksLikeCommand("move NET deals to Nurture")).toBe(true);
    expect(looksLikeCommand("Reach Plc")).toBe(false);
  });
});

describe("resolution", () => {
  it("matches users by full name, unique first name, prefix", () => {
    expect(matchUser("Will", V)).toBe("u-will");
    expect(matchUser("will turner", V)).toBe("u-will");
    expect(matchUser("Chris", V)).toBeNull(); // ambiguous
    expect(matchUser("chris p", V)).toBe("u-chris2");
    expect(matchUser("me", V)).toBe("u-me");
    expect(matchUser("Erik", V)).toBe("u-erik");
  });
  it("resolves a stage per pipeline, with category keywords", () => {
    const m = resolveStageTarget("Nurture", ["NET", "ENT"], V.stages);
    expect(m.get("NET")?.key).toBe("nurture");
    expect(m.has("ENT")).toBe(false);
    const lost = resolveStageTarget("lost", ["NET", "ENT"], V.stages);
    expect(lost.get("NET")?.name).toBe("Lost");
    expect(lost.get("ENT")?.name).toBe("Closed Lost");
    expect(resolveStageTarget("proposal", ["ENT"], V.stages).get("ENT")?.name).toBe("Proposal Sent");
    const stages = [...V.stages, { pipelineKey: "SPT", key: "cold", name: "Cold / Nurture", category: "open" as const }];
    expect(resolveStageTarget("Nurture", ["SPT"], stages).get("SPT")?.key).toBe("cold");
    expect(resolveStageTarget("cold nurture", ["SPT"], stages).get("SPT")?.key).toBe("cold");
    expect(resolveStageTarget("warm", ["SPT"], stages).has("SPT")).toBe(false);
  });
  it("normalizes tags", () => {
    expect(normalizeTag(' "Q4 Push!" ')).toBe("q4-push");
    expect(normalizeTag("#vip")).toBe("vip");
  });
  it("describes filters in plain language", () => {
    expect(describeFilter({ pipelineKeys: ["NET"], idleDays: 30 })).toBe("open NET deals · idle > 30 days");
    expect(describeFilter({ ids: ["a", "b"] })).toBe("2 selected deals");
  });
});

describe("rankEntries", () => {
  const entries = [
    { id: "go:/forecast", label: "Forecast", group: "Go to" },
    { id: "go:/pipelines", label: "Pipelines", group: "Go to" },
    { id: "cmd:create-deal", label: "Create deal", keywords: ["new deal"], group: "Create" },
    { id: "cmd:log-call", label: "Log call", keywords: ["call"], group: "Create" },
  ];
  it("prefix beats word-start beats subsequence; recents boost", () => {
    expect(rankEntries("fo", entries).map((e) => e.id)).toEqual(["go:/forecast"]);
    expect(rankEntries("deal", entries)[0]!.id).toBe("cmd:create-deal");
    expect(rankEntries("pln", entries).map((e) => e.id)).toEqual(["go:/pipelines"]);
    expect(rankEntries("", entries, { "cmd:log-call": 3 })[0]!.id).toBe("cmd:log-call");
  });
});

describe("close dates", () => {
  it("parses the verb and the 'no close date' filter", () => {
    expect(parseCommand("set close date of my NET deals without a close date to end of quarter", V).command).toEqual({
      verb: "close",
      filter: { owner: "me", noCloseDate: true, pipelineKeys: ["NET"] },
      date: "end of quarter",
    });
    expect(parseCommand("push close date for selected to Dec 15", V).command).toMatchObject({ verb: "close", filter: { ids: V.selection }, date: "Dec 15" });
  });
  it("resolves phrases against today (user zone)", () => {
    const today = "2026-10-01";
    expect(resolveCloseDate("end of quarter", today)).toBe("2026-12-31");
    expect(resolveCloseDate("end of next quarter", today)).toBe("2027-03-31");
    expect(resolveCloseDate("next quarter", "2026-05-10")).toBe("2026-09-30");
    expect(resolveCloseDate("end of month", today)).toBe("2026-10-31");
    expect(resolveCloseDate("end of next month", "2026-01-15")).toBe("2026-02-28");
    expect(resolveCloseDate("EOY", today)).toBe("2026-12-31");
    expect(resolveCloseDate("Q1", today)).toBe("2027-03-31");
    expect(resolveCloseDate("q4 2026", today)).toBe("2026-12-31");
    expect(resolveCloseDate("Dec 15", today)).toBe("2026-12-15");
    expect(resolveCloseDate("15 March", today)).toBe("2027-03-15");
    expect(resolveCloseDate("2026-11-30", today)).toBe("2026-11-30");
    expect(resolveCloseDate("2026-02-30", today)).toBeNull();
    expect(resolveCloseDate("Feb 30", today)).toBeNull();
    expect(resolveCloseDate("someday", today)).toBeNull();
  });
});
