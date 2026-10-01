import { describe, expect, it } from "vitest";
import { foldBulkOverrides, type DealException } from "../core";

const ex = (kind: DealException["kind"]): DealException => ({ kind, label: kind, detail: "" });

describe("bulk override folding (QA MAJ-21)", () => {
  it("drops deals whose only exception is a bulk-covered pending override and counts them per approval", () => {
    const rows = [
      { id: "a", exceptions: [ex("pending_override")] },
      { id: "b", exceptions: [ex("pending_override"), ex("low_health")] },
      { id: "c", exceptions: [ex("pending_override")] }, // its own (non-bulk) approval → stays
      { id: "d", exceptions: [ex("stalled")] },
    ];
    const r = foldBulkOverrides(rows, new Map([["a", "bulk1"], ["b", "bulk1"], ["d", "bulk1"]]));
    expect(r.rows.map((x) => x.id)).toEqual(["b", "c", "d"]);
    expect(r.rows.find((x) => x.id === "b")!.exceptions.map((e) => e.kind)).toEqual(["low_health"]);
    expect(r.rows.find((x) => x.id === "d")!.exceptions.map((e) => e.kind)).toEqual(["stalled"]);
    expect(r.bulk).toEqual([{ approvalId: "bulk1", deals: 2 }]);
  });
});
