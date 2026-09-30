import { describe, expect, it } from "vitest";
import { aggregatePipeline, type ReportDealRow } from "../report";
import { likelyObjections, agendaFor, OBJECTIONS } from "../playbook";
import { buildSystemPrompt } from "../prompt";

const row = (over: Partial<ReportDealRow>): ReportDealRow => ({
  pipelineKey: "NET",
  unit: "muu",
  stageName: "Hot",
  stageSort: 4,
  stageCategory: "open",
  stageProbability: 0.9,
  ownerName: "Ann",
  muu: 1_000_000,
  usdPerMuu: null,
  pipelineUsdPerMuu: 1,
  revSharePct: 0.3,
  pipelineRevSharePct: 0.5,
  contractValueCents: null,
  annualizedValueCents: null,
  probabilityOverride: null,
  overrideStatus: null,
  ...over,
});

describe("pipeline_report aggregation", () => {
  const rows = [
    row({}),
    row({ stageName: "Target", stageSort: 0, stageProbability: 0.1, ownerName: "Bob", probabilityOverride: 0.5, overrideStatus: "approved" }),
    row({ pipelineKey: "ADS", unit: "usd", stageName: "Verbal", stageSort: 2, muu: null, annualizedValueCents: 10_000_000, revSharePct: null }),
  ];
  it("labels gross vs net basis explicitly", () => {
    const g = aggregatePipeline(rows, { basis: "gross", groupBy: "stage", includeOverrides: true, pipelineKey: null, status: "open", revShareHidden: false });
    expect(g.basisLabel).toMatch(/^GROSS/);
    const n = aggregatePipeline(rows, { basis: "net", groupBy: "stage", includeOverrides: true, pipelineKey: null, status: "open", revShareHidden: false });
    expect(n.basisLabel).toMatch(/NET/);
    expect(g.totals.valueUsd).toBe(1_000_000 + 1_000_000 + 100_000);
    expect(n.totals.valueUsd).toBe(300_000 + 300_000 + 100_000);
  });
  it("uses the pipeline default share when deal terms are hidden for the role", () => {
    const n = aggregatePipeline(rows, { basis: "net", groupBy: "owner", includeOverrides: true, pipelineKey: null, status: "open", revShareHidden: true });
    expect(n.totals.valueUsd).toBe(500_000 + 500_000 + 100_000);
    expect(n.notes.join(" ")).toMatch(/hidden for your role/);
  });
  it("includes or excludes approved overrides in weighted values", () => {
    const withO = aggregatePipeline(rows, { basis: "gross", groupBy: "stage", includeOverrides: true, pipelineKey: null, status: "open", revShareHidden: false });
    const without = aggregatePipeline(rows, { basis: "gross", groupBy: "stage", includeOverrides: false, pipelineKey: null, status: "open", revShareHidden: false });
    expect(withO.overrideDeals).toBe(1);
    expect(withO.totals.weightedUsd).toBeCloseTo(900_000 + 500_000 + 90_000);
    expect(without.totals.weightedUsd).toBeCloseTo(900_000 + 100_000 + 90_000);
    expect(without.notes.join(" ")).toMatch(/overrides excluded/);
  });
  it("groups by stage with pipeline prefix across pipelines, ordered by stage", () => {
    const g = aggregatePipeline(rows, { basis: "gross", groupBy: "stage", includeOverrides: true, pipelineKey: null, status: "open", revShareHidden: false });
    expect(g.rows.map((r) => r.group)).toEqual(["ADS · Verbal", "NET · Target", "NET · Hot"]);
  });
});

describe("playbook", () => {
  it("ranks objections by keywords in recent activity", () => {
    const top = likelyObjections({ pipelineKey: "NET", text: "They asked whether we guarantee a minimum and worried about SEO during migration" });
    expect(top.slice(0, 2).map((o) => o.id).sort()).toEqual(["guarantees", "migration-risk"]);
  });
  it("covers the PRD objection themes", () => {
    const ids = OBJECTIONS.map((o) => o.id);
    for (const id of ["rev-share-fairness", "migration-risk", "loss-of-control", "guarantees", "crypto-skepticism", "why-not-hubspot-wp", "timing"]) expect(ids).toContain(id);
  });
  it("never uses banned claims in rebuttals", () => {
    const text = OBJECTIONS.map((o) => o.rebuttal).join(" ").toLowerCase();
    // seed banned/restricted claim patterns (scripts/seed.ts)
    for (const re of [/(paid in \d+ seconds|powered by coinbase|coinbase[- ]custod)/i, /\$?100\s?m(illion)?\s+(of\s+)?audited/i, /500\s?m(illion)?\s+(audience|reach|users)/i, /guarantee[d]? .{0,40}(today|current) (profit|revenue)/i, /(migrat\w+|clone\w*) .{0,20}(in )?2 hours/i, /(replace[sd]?|eliminate[sd]?) (all )?17 (software )?vendors/i])
      expect(text).not.toMatch(re);
  });
  it("has stage agendas with a generic fallback", () => {
    expect(agendaFor("nda")[0]).toMatch(/NDA/);
    expect(agendaFor("unknown").length).toBeGreaterThan(2);
  });
});

describe("system prompt", () => {
  it("includes date, role, context and guardrails", () => {
    const p = buildSystemPrompt({ base: "BASE", now: new Date("2026-09-30T15:00:00Z"), timezone: "America/New_York", userName: "Dev SDR", roleLabel: "SDR", contextLines: ["Deal \"X\""], webResearchEnabled: false });
    expect(p).toContain("BASE");
    expect(p).toContain("2026");
    expect(p).toContain("role: SDR");
    expect(p).toContain('Deal "X"');
    expect(p).toMatch(/<untrusted> tags/);
    expect(p).toMatch(/not configured/);
  });
});
