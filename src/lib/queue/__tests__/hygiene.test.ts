import { describe, expect, it } from "vitest";
import { applySnoozes, approvalCopy, collapseGroups, dropDeleted, hasExternalAttendee, itemSubjects, replyKey, threadIdOfKey } from "../core";
import { focusedRowKey, safeQueueHref, undoPlan } from "../undo-core";
import type { QueueItem } from "../types";

const D1 = "6b68264c-7a03-4f9b-b6fb-57598cb18dd6";
const D2 = "11ff1828-0000-4000-8000-000000000001";
const A1 = "01e5f31a-0000-4000-8000-000000000002";
const item = (key: string, over: Partial<QueueItem> = {}): QueueItem => ({ key, kind: "alert", title: key, href: "/", urgency: 30, actions: [], ...over });

describe("soft-deleted records never reach Today (QA MIN-41)", () => {
  it("finds the subject from explicit ids or the link", () => {
    expect(itemSubjects({ href: `/deals/${D1}?tab=x` })).toEqual({ dealId: D1, accountId: null });
    expect(itemSubjects({ href: `/accounts/${A1}` })).toEqual({ dealId: null, accountId: A1 });
    expect(itemSubjects({ href: "/tasks?task=1", dealId: D2 })).toEqual({ dealId: D2, accountId: null });
    expect(itemSubjects({ href: "/deals?owner=none" })).toEqual({ dealId: null, accountId: null });
  });
  it("drops alerts, tasks and provider rows about deleted deals/accounts, keeps the rest", () => {
    const rows = [
      item("alert:1", { href: `/deals/${D1}`, title: "ZZ V2 test Alpha: missing primary contact" }),
      item("task:2", { kind: "task", href: "/tasks?task=2", dealId: D1 }),
      item("signal:3", { kind: "signal", href: `/deals/${D2}` }),
      item("x:4", { href: `/accounts/${A1}` }),
      item("approval:5", { kind: "approval", href: "/tasks?tab=approvals" }),
    ];
    const out = dropDeleted(rows, { deals: new Set([D1]), accounts: new Set([A1]) });
    expect(out.map((i) => i.key)).toEqual(["signal:3", "approval:5"]);
  });
});

describe("reply rows come back on a new message (code review M6)", () => {
  it("versions the key by the latest message", () => {
    const a = replyKey("t1", new Date("2026-10-01T10:00:00Z"));
    const b = replyKey("t1", new Date("2026-10-03T09:00:00Z"));
    expect(a).not.toBe(b);
    expect(threadIdOfKey(a)).toBe("t1");
    expect(replyKey("t1", null)).toBe("thread:t1");
  });
  it("a dismissal of the old version no longer hides the thread after a new inbound message", () => {
    const old = replyKey("t1", "2026-10-01T10:00:00Z");
    const now = new Date("2026-10-03T12:00:00Z");
    const snoozes = [{ itemKey: old, until: null }];
    expect(applySnoozes([{ key: old }], snoozes, now)).toEqual([]);
    const fresh = replyKey("t1", "2026-10-03T09:00:00Z");
    expect(applySnoozes([{ key: fresh }], snoozes, now)).toEqual([{ key: fresh }]);
  });
});

describe("identical rows collapse into one (QA MAJ-21)", () => {
  const spec = () => ({ title: (n: number) => `${n} unassigned high-value leads`, href: "/deals?owner=none", cta: "Assign owners" });
  it("9 identical alerts become one grouped row with a link to the filtered list", () => {
    const names = ["Sinclair", "UPI", "The News Movement", "A", "B", "C", "D", "E", "F"];
    const rows = [item("task:x", { kind: "task" }), ...names.map((n, i) => item(`alert:${i}`, { title: `Unassigned high-value lead: ${n}`, group: "alert:NS-15", severity: i === 4 ? "critical" : "serious" }))];
    const out = collapseGroups(rows, spec);
    expect(out).toHaveLength(2);
    const g = out[1]!;
    expect(g.key).toBe("group:alert:NS-15");
    expect(g.title).toBe("9 unassigned high-value leads");
    expect(g.href).toBe("/deals?owner=none");
    expect(g.severity).toBe("critical");
    expect(g.detail).toBe("Sinclair, UPI, The News Movement +6 more");
    expect(g.actions[0]).toEqual({ kind: "link", label: "Assign owners", href: "/deals?owner=none" });
    expect(g.actions.some((a) => a.kind === "done")).toBe(false);
  });
  it("leaves small groups and ungrouped rows alone", () => {
    const rows = [item("alert:1", { group: "g" }), item("alert:2", { group: "g" }), item("alert:3")];
    expect(collapseGroups(rows, spec).map((i) => i.key)).toEqual(["alert:1", "alert:2", "alert:3"]);
  });
});

describe("approval copy", () => {
  it("labels a bulk request as one decision", () => {
    expect(approvalCopy("147 deals (bulk)", "probability_override", "Kade")).toEqual({
      title: "Approve one bulk probability override (147 deals)",
      detail: "One decision covers all 147 deals · from Kade",
    });
    expect(approvalCopy("Acme — Proposal", "stage_gate", null)).toEqual({ title: "Approve: Acme — Proposal", detail: "stage gate" });
  });
});

describe("internal-only meetings get no Prep (QA MIN-24)", () => {
  it("detects external attendees, subdomains count as internal", () => {
    const internal = ["roundtable.io", "blockchainff.com"];
    expect(hasExternalAttendee(["a@roundtable.io", "b@eu.roundtable.io"], internal)).toBe(false);
    expect(hasExternalAttendee(["a@roundtable.io", "ceo@acme.com"], internal)).toBe(true);
    expect(hasExternalAttendee([], internal)).toBe(false);
  });
});

describe("Today keyboard and undo (QA MAJ-01)", () => {
  const el = (rowKey: string | null) => ({ closest: (sel: string) => (sel === "[data-queue-row]" && rowKey ? { getAttribute: () => rowKey } : null) });
  it("acts only on the focused row; nothing when focus is outside the queue", () => {
    expect(focusedRowKey(el("alert:1"))).toBe("alert:1");
    expect(focusedRowKey(el(null))).toBeNull();
    expect(focusedRowKey(null)).toBeNull();
  });
  it("undo reverses done and snooze for every kind, alerts included", () => {
    expect(undoPlan("task", "done")).toBe("task.reopen");
    expect(undoPlan("task", "snooze")).toBe("task.unsnooze");
    expect(undoPlan("alert", "done")).toBe("alert.reopen");
    expect(undoPlan("alert", "snooze")).toBe("alert.reopen");
    expect(undoPlan("thread", "done")).toBe("queue.restore");
  });
});

describe("server-action follow-up links (FX-2 'Review move')", () => {
  it("follows same-origin paths only", () => {
    expect(safeQueueHref("/deals/abc?move=s1&signal=x")).toBe("/deals/abc?move=s1&signal=x");
    expect(safeQueueHref("//evil.example/x")).toBeNull();
    expect(safeQueueHref("https://evil.example")).toBeNull();
    expect(safeQueueHref("/\\evil")).toBeNull();
    expect(safeQueueHref(undefined)).toBeNull();
  });
});
