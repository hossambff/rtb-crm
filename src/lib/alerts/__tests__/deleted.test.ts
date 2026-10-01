import { describe, expect, it, vi } from "vitest";
import { RECORD_DELETED_RESOLUTION, resolveAlertsForDeleted } from "../deleted";
import { SUPPRESSING_RESOLUTION_PREFIXES } from "../suppression";

/** Minimal drizzle-like update chain that records each call. */
function fakeDb(returnedPerCall: number) {
  const sets: unknown[] = [];
  const update = vi.fn(() => ({
    set: (v: unknown) => {
      sets.push(v);
      return { where: () => ({ returning: async () => Array.from({ length: returnedPerCall }, (_, i) => ({ id: String(i) })) }) };
    },
  }));
  return { db: { update } as never, update, sets };
}

describe("alerts on deleted records", () => {
  it("the resolution never suppresses re-raising (it isn't a person's decision)", () => {
    expect(SUPPRESSING_RESOLUTION_PREFIXES.some((p) => RECORD_DELETED_RESOLUTION.startsWith(p))).toBe(false);
  });

  it("resolves in chunks of 500 and counts closed alerts", async () => {
    const f = fakeDb(2);
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(await resolveAlertsForDeleted(f.db, "deal", ids)).toBe(6);
    expect(f.update).toHaveBeenCalledTimes(3);
    expect(f.sets[0]).toMatchObject({ state: "resolved", resolution: RECORD_DELETED_RESOLUTION });
  });

  it("does nothing for an empty id list", async () => {
    const f = fakeDb(1);
    expect(await resolveAlertsForDeleted(f.db, "account", [])).toBe(0);
    expect(f.update).not.toHaveBeenCalled();
  });
});
