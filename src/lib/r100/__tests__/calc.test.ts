import { describe, expect, it } from "vitest";
import { burnUp, interviewOverdue, interviewSummary, isLive, mergeR100, parseInterviews, participationNow } from "../calc";

const now = new Date("2026-09-30T12:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("r100 calc", () => {
  it("live stages", () => {
    expect(isLive({ key: "first_post", category: "won" })).toBe(true);
    expect(isLive({ key: "hot", category: "open" })).toBe(false);
  });
  it("participation this month", () => {
    expect(participationNow({}, now)).toBe("not_live");
    expect(participationNow({ firstPostDate: "2026-08-15", participation: [true, true, false] }, now)).toBe("posted");
    expect(participationNow({ firstPostDate: "2026-09-02", participation: [false] }, now)).toBe("missing");
    expect(participationNow({ firstPostDate: "2026-01-02" }, now)).toBe("beyond");
  });
  it("burn-up is cumulative by first post month", () => {
    const pts = burnUp(
      [
        { firstPostDate: "2026-07-10", wonAt: null },
        { firstPostDate: null, wonAt: d("2026-08-03") },
        { firstPostDate: "2026-09-01", wonAt: null },
      ],
      now,
    );
    expect(pts.map((p) => p.live)).toEqual([1, 2, 3]);
    expect(pts.at(-1)!.month).toBe("2026-09");
  });
  it("interviews parsing and alerts", () => {
    const list = parseInterviews({ interviews: [{ guest: "CEO", host: "Jackson", status: "filmed", filmedAt: "2026-09-01" }, { bogus: 1 }] });
    expect(list).toHaveLength(2);
    expect(list[1]!.status).toBe("scheduled");
    expect(interviewSummary(list)).toBe("filmed");
    expect(interviewOverdue(list[0]!, now)).toBe(true);
    expect(parseInterviews(null)).toEqual([]);
  });
  it("mergeR100 normalizes", () => {
    expect(mergeR100({ postCount: 2 }, { participation: [true], postCount: 3.6 })).toEqual({ postCount: 4, participation: [true, false, false] });
  });
});
