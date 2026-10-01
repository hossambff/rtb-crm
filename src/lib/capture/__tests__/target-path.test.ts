import { describe, expect, it } from "vitest";
import { captureTargetFromPath } from "../core";

const id = "11ff1828-0000-4000-8000-000000000001";
describe("captureTargetFromPath (QA MIN-12)", () => {
  it("recognises deal and account pages", () => {
    expect(captureTargetFromPath(`/deals/${id}`)).toEqual({ kind: "deal", id });
    expect(captureTargetFromPath(`/deals/${id}/edit?tab=x`)).toEqual({ kind: "deal", id });
    expect(captureTargetFromPath(`/accounts/${id.toUpperCase()}`)).toEqual({ kind: "account", id });
  });
  it("ignores everything else", () => {
    expect(captureTargetFromPath("/deals")).toBeNull();
    expect(captureTargetFromPath("/contacts/" + id)).toBeNull();
    expect(captureTargetFromPath(`/deals/${id}x`)).toBeNull();
    expect(captureTargetFromPath(null)).toBeNull();
  });
});
