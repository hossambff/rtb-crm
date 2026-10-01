import { describe, expect, it } from "vitest";
import { chunks, commandFieldHidden, partitionForUndo, sameInstant } from "../undo-core";
import { actionsLeadForQuery } from "../parse";

describe("command undo is compare-and-set (CR M2)", () => {
  it("reverts only records still holding the value the command set", () => {
    const cur = new Map<string, string | null>([
      ["a", "stage-nurture"],
      ["b", "stage-proposal"], // a rep moved it on afterwards
      ["c", "stage-nurture"],
    ]);
    expect(partitionForUndo(["a", "b", "c", "d"], cur, "stage-nurture")).toEqual({ eligible: ["a", "c"], changed: ["b", "d"] });
  });

  it("handles null expectations (cleared values) and legacy tokens without one", () => {
    const cur = new Map<string, string | null>([["a", null], ["b", "x"]]);
    expect(partitionForUndo(["a", "b"], cur, null)).toEqual({ eligible: ["a"], changed: ["b"] });
    expect(partitionForUndo(["a", "b"], cur, undefined)).toEqual({ eligible: ["a", "b"], changed: [] });
  });

  it("compares instants, not string formats", () => {
    expect(sameInstant("2026-12-15T22:00:00.000Z", "2026-12-15T22:00:00Z")).toBe(true);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant("2026-12-15T22:00:00Z", null)).toBe(false);
  });
});

describe("bulk execution chunks (CR M4)", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 3)).toEqual([]);
  });
});

describe("field-level security for commands (SEC L-5 / CR M3)", () => {
  it("blocks close/tag when the field (or the whole entity) is hidden", () => {
    expect(commandFieldHidden("close", new Set(["expectedCloseDate"]))).toBe("expectedCloseDate");
    expect(commandFieldHidden("tag", new Set(["tags"]))).toBe("tags");
    expect(commandFieldHidden("tag", new Set(["*"]))).toBe("tags");
    expect(commandFieldHidden("close", new Set(["tags"]))).toBeNull();
    expect(commandFieldHidden("move", new Set(["*"]))).toBeNull();
  });
});

describe("⌘K verb queries keep actions visible (QA MAJ-20)", () => {
  const entries = [
    { id: "note", label: "Add note to deal", keywords: ["note", "create note"], group: "Create" },
    { id: "move", label: "Move deals to a stage…", keywords: ["move", "stage", "bulk"], group: "Bulk" },
    { id: "task", label: "New task", keywords: ["create task"], group: "Create" },
  ];
  it("leads with actions when the query names one", () => {
    expect(actionsLeadForQuery("add note", entries)).toBe(true);
    expect(actionsLeadForQuery("add note to Acme renewal", entries)).toBe(true);
    expect(actionsLeadForQuery("create task", entries)).toBe(true);
  });
  it("leads with the command preview for real commands", () => {
    expect(actionsLeadForQuery("move NET deals idle 30 days to Nurture", entries)).toBe(false);
    expect(actionsLeadForQuery("assign these to Will", entries)).toBe(false);
  });
});
