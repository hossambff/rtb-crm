import { describe, expect, it } from "vitest";
import { applySnoozes, parseQueueKey, queueScore, rankQueue, snoozeUntil, suggestQuestions } from "../core";
import type { QueueItem } from "../types";

const NY = "America/New_York";
const NOW = new Date("2026-09-30T15:00:00Z"); // Wed 11:00 NY
const H = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const item = (key: string, over: Partial<QueueItem> = {}): QueueItem => ({ key, kind: "task", title: key, href: "/", urgency: 30, actions: [], ...over });

describe("rankQueue", () => {
  it("puts critical alerts and overdue work first, undated low-urgency last", () => {
    const ranked = rankQueue(
      [
        item("task:later", { dueAt: at(30 * H) }),
        item("task:overdue", { dueAt: at(-2 * H) }),
        item("alert:crit", { kind: "alert", severity: "critical", urgency: 35 }),
        item("story:x", { kind: "story", urgency: 10 }),
        item("task:soon", { dueAt: at(1 * H) }),
      ],
      NOW,
    ).map((i) => i.key);
    expect(ranked[0]).toBe("alert:crit");
    expect(ranked.indexOf("task:overdue")).toBeLessThan(ranked.indexOf("task:soon"));
    expect(ranked.indexOf("task:soon")).toBeLessThan(ranked.indexOf("task:later"));
    expect(ranked.at(-1)).toBe("story:x");
  });

  it("more overdue ranks higher, capped", () => {
    expect(queueScore(item("a", { dueAt: at(-48 * H) }), NOW)).toBeGreaterThan(queueScore(item("b", { dueAt: at(-1 * H) }), NOW));
    expect(queueScore(item("a", { dueAt: at(-1000 * H) }), NOW)).toBe(30 + 40);
  });

  it("is stable for equal scores and ties break on earliest due", () => {
    const same = [item("task:1"), item("task:2"), item("task:3")];
    expect(rankQueue(same, NOW).map((i) => i.key)).toEqual(["task:1", "task:2", "task:3"]);
    const due = [item("task:b", { dueAt: at(5 * H), urgency: 30 }), item("task:a", { dueAt: at(4 * H), urgency: 30 })];
    expect(rankQueue(due, NOW).map((i) => i.key)).toEqual(["task:a", "task:b"]);
  });

  it("drops duplicate keys and tolerates bad input", () => {
    const r = rankQueue([item("task:1"), item("task:1", { title: "dup" }), item("x:1", { urgency: Number.NaN, dueAt: "nope" })], NOW);
    expect(r).toHaveLength(2);
    expect(r.find((i) => i.key === "task:1")!.title).toBe("task:1");
  });

  it("clamps provider urgency to 0..100", () => {
    expect(queueScore(item("a", { urgency: 999 }), NOW)).toBe(100);
    expect(queueScore(item("a", { urgency: -5 }), NOW)).toBe(0);
  });
});

describe("snoozeUntil", () => {
  it("1 hour", () => expect(snoozeUntil("1h", NOW, NY).toISOString()).toBe("2026-09-30T16:00:00.000Z"));
  it("tomorrow 9am in the user's zone", () => expect(snoozeUntil("tomorrow", NOW, NY).toISOString()).toBe("2026-10-01T13:00:00.000Z"));
  it("next Monday 9am", () => expect(snoozeUntil("monday", NOW, NY).toISOString()).toBe("2026-10-05T13:00:00.000Z"));
  it("on a Monday, next Monday means a week later", () =>
    expect(snoozeUntil("monday", new Date("2026-10-05T15:00:00Z"), NY).toISOString()).toBe("2026-10-12T13:00:00.000Z"));
  it("respects other zones", () => expect(snoozeUntil("tomorrow", NOW, "Europe/London").toISOString()).toBe("2026-10-01T08:00:00.000Z"));
});

describe("applySnoozes / parseQueueKey", () => {
  it("hides dismissed and future snoozes, shows expired ones", () => {
    const items = [{ key: "thread:a" }, { key: "thread:b" }, { key: "thread:c" }, { key: "thread:d" }];
    const out = applySnoozes(
      items,
      [
        { itemKey: "thread:a", until: null },
        { itemKey: "thread:b", until: at(H) },
        { itemKey: "thread:c", until: at(-H) },
      ],
      NOW,
    );
    expect(out.map((i) => i.key)).toEqual(["thread:c", "thread:d"]);
  });
  it("parses keys with colons in the id", () => {
    expect(parseQueueKey("signal:abc:1")).toEqual({ kind: "signal", id: "abc:1" });
    expect(parseQueueKey("nokey")).toBeNull();
    expect(parseQueueKey("task:")).toBeNull();
  });
});

describe("suggestQuestions", () => {
  const base = { noNextStep: 0, overdueTasks: 0, dueToday: 0, openAlerts: 0, awaitingReply: 0, meetingsToday: 0, isLeader: false };
  it("leads with data-backed questions", () => {
    const q = suggestQuestions({ ...base, noNextStep: 3 }, 0);
    expect(q[0]).toBe("Which of my deals have no next step?");
    expect(q).toHaveLength(3);
    expect(new Set(q).size).toBe(3);
  });
  it("rotates by day and falls back to generic prompts", () => {
    const a = suggestQuestions(base, 1);
    const b = suggestQuestions(base, 2);
    expect(a).toHaveLength(3);
    expect(a).not.toEqual(b);
  });
  it("leaders get a team question", () => {
    expect(suggestQuestions({ ...base, isLeader: true }, 0)).toContain("Which deals on my team slipped this week?");
  });
});
