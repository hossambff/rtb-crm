import { describe, expect, it } from "vitest";
import { auditQuery, csvCell, jsonDiff, parseAuditFilters, toCsv, visibleDiff } from "../audit-core";
import { buildGrid } from "../permissions-core";
import { isPlaceholderEmail, mergeSplitPct, summarize, USER_KEYED_TABLES, USER_REF_COLUMNS } from "../claim-plan";

describe("jsonDiff", () => {
  it("reports added, removed and changed paths", () => {
    const d = jsonDiff({ a: 1, b: { c: 2, d: [1] }, e: "x", updatedAt: 1 }, { a: 1, b: { c: 3, d: [1, 2] }, f: true, updatedAt: 2 });
    expect(d).toEqual([
      { path: "b.c", kind: "changed", before: 2, after: 3 },
      { path: "b.d", kind: "changed", before: [1], after: [1, 2] },
      { path: "e", kind: "removed", before: "x" },
      { path: "f", kind: "added", after: true },
      { path: "updatedAt", kind: "changed", before: 1, after: 2 },
    ]);
    expect(visibleDiff(d).map((e) => e.path)).not.toContain("updatedAt");
  });
  it("handles creates, deletes and scalars", () => {
    expect(jsonDiff(null, { a: 1 })).toEqual([{ path: "(value)", kind: "added", after: { a: 1 } }]);
    expect(jsonDiff({ a: 1 }, null)).toEqual([{ path: "(value)", kind: "removed", before: { a: 1 } }]);
    expect(jsonDiff("warn", "block")).toEqual([{ path: "(value)", kind: "changed", before: "warn", after: "block" }]);
    expect(jsonDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe("csv", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsv(["a", "b"], [[1, "x\ny"]])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});

describe("audit filters", () => {
  it("parses and sanitises", () => {
    expect(parseAuditFilters({ actor: "u1", from: "2026-09-01", to: "not-a-date", page: "3" })).toEqual({
      actor: "u1",
      entity: null,
      action: null,
      from: "2026-09-01",
      to: null,
      page: 3,
    });
    expect(parseAuditFilters({ page: "-2" }).page).toBe(1);
  });
  it("builds query strings", () => {
    const f = parseAuditFilters({ entity: "deal" });
    expect(auditQuery(f)).toBe("?entity=deal");
    expect(auditQuery(f, { page: 2 })).toBe("?entity=deal&page=2");
  });
});

describe("permission grid", () => {
  it("overlays overrides on defaults and flags only real differences", () => {
    const grid = buildGrid("sdr", [
      { module: "accounts", action: "delete", scope: "own" },
      { module: "accounts", action: "view", scope: "all" }, // same as default → not an override
    ]);
    const acc = grid.find((row) => row[0]!.module === "accounts")!;
    expect(acc.find((c) => c.action === "delete")).toMatchObject({ scope: "own", def: "none", override: true });
    expect(acc.find((c) => c.action === "view")).toMatchObject({ scope: "all", override: false });
    expect(grid.flat().filter((c) => c.override)).toHaveLength(1);
  });
});

describe("claim plan", () => {
  it("detects placeholder emails", () => {
    expect(isPlaceholderEmail("chris.placeholder@roundtable.invalid")).toBe(true);
    expect(isPlaceholderEmail("CHRIS.PLACEHOLDER@ROUNDTABLE.INVALID")).toBe(true);
    expect(isPlaceholderEmail("chris@roundtable.io")).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
  });
  it("covers the required ownership columns and never the audit log", () => {
    const refs = USER_REF_COLUMNS.map((r) => `${r.table}.${r.column}`);
    for (const need of ["deals.owner_id", "tasks.assignee_id", "accounts.owner_id", "contacts.owner_id", "contacts.relationship_owner_id", "activities.actor_id", "commission_accruals.user_id"])
      expect(refs).toContain(need);
    expect(refs.some((r) => r.startsWith("audit_log"))).toBe(false);
    expect(USER_KEYED_TABLES.map((t) => t.table)).toEqual(expect.arrayContaining(["deal_splits", "commission_assignments"]));
  });
  it("merges split percentages", () => {
    expect(mergeSplitPct(50, 50)).toBe(100);
    expect(mergeSplitPct(70, 50)).toBe(100);
    expect(mergeSplitPct(33.333, 33.333)).toBe(66.67);
  });
  it("summarises counts", () => {
    expect(summarize({ deals: 3, tasks: 0, deal_splits: 2 })).toBe("3 deals, 2 deal splits");
    expect(summarize({})).toBe("no records");
  });
});
