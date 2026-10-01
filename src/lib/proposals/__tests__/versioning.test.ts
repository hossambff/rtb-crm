import { describe, expect, it } from "vitest";
import { isVersionConflict, retryOnVersionConflict, VERSION_UNIQUE_INDEX } from "../versioning-core";

const conflict = () => Object.assign(new Error("dup"), { cause: { code: "23505", constraint_name: VERSION_UNIQUE_INDEX } });

describe("proposal version conflicts", () => {
  it("detects the version unique index only", () => {
    expect(isVersionConflict(conflict())).toBe(true);
    expect(isVersionConflict({ code: "23505", constraint_name: VERSION_UNIQUE_INDEX })).toBe(true);
    expect(isVersionConflict({ code: "23505" })).toBe(true); // driver without a constraint name
    expect(isVersionConflict({ cause: { code: "23505", constraint_name: "documents_pkey" } })).toBe(false);
    expect(isVersionConflict({ code: "23503" })).toBe(false);
    expect(isVersionConflict(new Error("x"))).toBe(false);
  });
  it("retries once, then throws the friendly error", async () => {
    let n = 0;
    await expect(retryOnVersionConflict(async () => (++n === 1 ? Promise.reject(conflict()) : n), () => new Error("friendly"))).resolves.toBe(2);
    n = 0;
    await expect(retryOnVersionConflict(async () => { n++; throw conflict(); }, () => new Error("friendly"))).rejects.toThrow("friendly");
    expect(n).toBe(2);
    await expect(retryOnVersionConflict(async () => { throw new Error("other"); }, () => new Error("friendly"))).rejects.toThrow("other");
  });
});
