import { describe, expect, it } from "vitest";
import { buildThreads, countLive, newMentions, resolveMentions, type CommentRow } from "../core";

const row = (id: string, at: string, extra: Partial<CommentRow> = {}): CommentRow => ({
  id,
  parentId: null,
  authorId: "u1",
  authorName: "Ann",
  authorImage: null,
  body: `body ${id}`,
  createdAt: `2026-10-01T10:${at}:00.000Z`,
  editedAt: null,
  deletedAt: null,
  ...extra,
});

describe("deal threads", () => {
  it("nests one level, hides deleted replies, keeps deleted parents only while they have replies", () => {
    const rows = [
      row("a", "01"),
      row("r1", "02", { parentId: "a", authorId: "u2" }),
      row("r2", "03", { parentId: "a", deletedAt: "2026-10-01T11:00:00Z" }),
      row("b", "04", { deletedAt: "2026-10-01T11:00:00Z" }),
      row("c", "05", { deletedAt: "2026-10-01T11:00:00Z" }),
      row("r3", "06", { parentId: "c" }),
      row("orphan", "07", { parentId: "zzz" }),
    ];
    const t = buildThreads(rows, "u1");
    expect(t.map((x) => x.id)).toEqual(["a", "c", "orphan"]);
    expect(t[0]!.replies.map((r) => r.id)).toEqual(["r1"]);
    expect(t[0]!.mine).toBe(true);
    expect(t[0]!.replies[0]!.mine).toBe(false);
    expect(t[1]!.deleted).toBe(true);
    expect(t[1]!.body).toBe("");
    expect(countLive(t)).toBe(4);
  });

  it("mentions resolve only against the deal audience and must still be in the text", () => {
    const audience = [
      { id: "u1", name: "Chris Smith" },
      { id: "u2", name: "Will Heckman" },
    ];
    expect(resolveMentions("@Chris Smith can you join? cc @Mallory", audience)).toEqual(["u1"]);
    expect(resolveMentions("thanks all", audience, ["u2"])).toEqual([]);
    expect(resolveMentions("over to @will heckman", audience, ["u2", "outsider"])).toEqual(["u2"]);
    expect(newMentions(["u1"], ["u1", "u2"])).toEqual(["u2"]);
  });
});
