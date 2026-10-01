import { describe, expect, it } from "vitest";
import {
  canApplyNewSteps,
  computeMetrics,
  isAutoReply,
  isOnOlderVersion,
  isSystemPause,
  KNOWN_VARIABLES,
  hasOptOutLine,
  looksLikeOutOfOffice,
  mailboxCap,
  normalizeSteps,
  stepsEqual,
  stepsForEnrollment,
  templateVariables,
  validateSequence,
  type HistoryEntry,
  type Step,
} from "../core";
import { STARTER_SEQUENCES } from "../starters";
import { findClaimHits, type ClaimRule } from "@/lib/claims-core";
import { CLAIM_PATTERNS } from "@/lib/claims-patterns";

const v1: Step[] = normalizeSteps([
  { kind: "email", delayDays: 0, subject: "Hi", body: "Intro" },
  { kind: "email", delayDays: 3, body: "Bump" },
  { kind: "task", delayDays: 2, title: "Call" },
]);

describe("stepsForEnrollment (SEC H-3 / CR H-3)", () => {
  it("uses the enrollment snapshot, never the edited live steps", () => {
    const live = normalizeSteps([{ kind: "linkedin", delayDays: 0, title: "New first step" }, ...v1]);
    expect(stepsForEnrollment({ stepsSnapshot: v1, stepsVersion: 1 }, { steps: live, version: 2 })).toBe(v1);
  });
  it("legacy rows fall back to live steps only while the version still matches", () => {
    expect(stepsForEnrollment({ stepsSnapshot: null, stepsVersion: null }, { steps: v1, version: 1 })).toBe(v1);
    expect(stepsForEnrollment({ stepsSnapshot: null, stepsVersion: null }, { steps: v1, version: 2 })).toBeNull();
    expect(stepsForEnrollment({ stepsSnapshot: [], stepsVersion: 3 }, { steps: v1, version: 3 })).toBe(v1);
  });
  it("knows who is on an older version", () => {
    expect(isOnOlderVersion({ stepsVersion: 1 }, 2)).toBe(true);
    expect(isOnOlderVersion({ stepsVersion: null }, 1)).toBe(false);
    expect(isOnOlderVersion({ stepsVersion: 2 }, 2)).toBe(false);
  });
  it("detects step changes, ignoring normalization noise", () => {
    expect(stepsEqual(v1, normalizeSteps(v1))).toBe(true);
    expect(stepsEqual(v1, [...v1, { kind: "task", delayDays: 1, title: "x" }])).toBe(false);
  });
});

describe("canApplyNewSteps", () => {
  it("allows any change before the first step ran", () => {
    expect(canApplyNewSteps(v1, normalizeSteps([{ kind: "task", delayDays: 0, title: "x" }]), 0)).toBe(true);
  });
  it("allows text edits and appends after completed steps", () => {
    const edited = normalizeSteps([{ ...v1[0]!, body: "Better intro" }, { ...v1[1]!, body: "Better bump" }, v1[2]!, { kind: "email", delayDays: 4, body: "Last" }]);
    expect(canApplyNewSteps(v1, edited, 2)).toBe(true);
  });
  it("refuses an insert before the current step (would re-send the intro)", () => {
    const inserted = normalizeSteps([{ kind: "linkedin", delayDays: 0, title: "Connect" }, ...v1]);
    expect(canApplyNewSteps(v1, inserted, 1)).toBe(false);
  });
  it("refuses a thread-behaviour change on a sent step, and a shrink below progress", () => {
    const newThread = normalizeSteps([v1[0]!, { ...v1[1]!, replyInThread: false, subject: "New" }, v1[2]!]);
    expect(canApplyNewSteps(v1, newThread, 2)).toBe(false);
    expect(canApplyNewSteps(v1, v1.slice(0, 1), 2)).toBe(false);
  });
});

describe("isSystemPause (QA MAJ-12)", () => {
  const h = (e: Partial<HistoryEntry>): HistoryEntry => ({ step: 0, at: "2026-10-01T00:00:00Z", kind: "paused", ok: false, ...e });
  it("system pauses can be resumed in bulk; manual ones cannot", () => {
    expect(isSystemPause([h({ note: "Gmail revoked" })], "Gmail revoked")).toBe(true);
    expect(isSystemPause([h({ ok: true, note: "manual", by: "u1" })], null)).toBe(false);
    expect(isSystemPause([h({ note: "x" }), h({ ok: true, note: "manual" })], "stale")).toBe(false);
  });
  it("legacy rows rely on lastError", () => {
    expect(isSystemPause([], "Gmail disconnected")).toBe(true);
    expect(isSystemPause([], null)).toBe(false);
  });
});

describe("mailboxCap (QA MIN-25)", () => {
  it("uses the strictest cap of the mailbox's sequences", () => {
    expect(mailboxCap([200, 20, 40])).toBe(20);
    expect(mailboxCap([500])).toBe(200);
    expect(mailboxCap([])).toBe(40);
  });
});

describe("computeMetrics (QA MIN-26)", () => {
  it("does not count opt-outs as replies", () => {
    const m = computeMetrics([
      { status: "exited", exitReason: "replied", n: 2 },
      { status: "exited", exitReason: "unsubscribed", n: 3 },
      { status: "active", exitReason: null, n: 5 },
    ]);
    expect(m.replied).toBe(2);
    expect(m.unsubscribed).toBe(3);
    expect(m.replyRate).toBeCloseTo(0.2);
  });
});

describe("auto-replies (CR L15)", () => {
  it("recognises RFC 3834 headers and OOO subjects", () => {
    expect(isAutoReply({ autoSubmitted: "auto-replied" })).toBe(true);
    expect(isAutoReply({ autoSubmitted: "no", subject: "Re: Idea" })).toBe(false);
    expect(isAutoReply({ xAutoreply: "yes" })).toBe(true);
    expect(isAutoReply({ subject: "Automatic reply: Idea for Acme" })).toBe(true);
    expect(isAutoReply({ subject: "Out of Office: back Monday" })).toBe(true);
    expect(isAutoReply({ subject: "Re: Idea for Acme" })).toBe(false);
  });
  it("treats short out-of-office bodies as auto, long human replies as replies", () => {
    expect(looksLikeOutOfOffice("I am out of the office until Monday with limited access to email.")).toBe(true);
    expect(looksLikeOutOfOffice("Thanks, interested. Can we talk Thursday?")).toBe(false);
    expect(looksLikeOutOfOffice(`I'm out of the office but ${"really interested ".repeat(80)}`)).toBe(false);
  });
});

describe("starter sequences (scripts/seed-sequences.ts)", () => {
  const rules: ClaimRule[] = [
    { id: "1", text: "paid", pattern: CLAIM_PATTERNS.paidInSeconds, status: "banned", approvedAlternative: null },
    { id: "2", text: "audited", pattern: CLAIM_PATTERNS.auditedRevenue100m, status: "banned", approvedAlternative: null },
    { id: "3", text: "17 vendors", pattern: "(replace[sd]?|eliminate[sd]?) (all )?17 (software )?vendors", status: "restricted", approvedAlternative: null },
    { id: "4", text: "500M", pattern: "500\\s?m(illion)?\\s+(audience|reach|users)", status: "restricted", approvedAlternative: null },
    { id: "5", text: "guarantee", pattern: "guarantee[d]? .{0,40}(today|current) (profit|revenue)", status: "restricted", approvedAlternative: null },
    { id: "6", text: "2 hours", pattern: "(migrat\\w+|clone\\w*) .{0,20}(in )?2 hours", status: "restricted", approvedAlternative: null },
  ];
  it("are three valid, claim-safe templates with only the allowed variables and an opt-out line", () => {
    expect(STARTER_SEQUENCES).toHaveLength(3);
    const allowed = new Set(["first_name", "company", "sender_first_name", "opener"]);
    for (const q of STARTER_SEQUENCES) {
      expect(validateSequence(q.steps)).toEqual([]);
      const text = q.steps.map((s) => [s.subject, s.body, s.title].filter(Boolean).join("\n")).join("\n");
      expect(findClaimHits(text, rules)).toEqual([]);
      expect(text.replace(/Roundtable 100/g, "")).not.toMatch(/\d{2,}|premium|cpm|rpm|guarantee|[—–]/i);
      for (const v of templateVariables(text)) {
        expect(allowed.has(v.name)).toBe(true);
        expect(KNOWN_VARIABLES).toContain(v.name);
      }
      const firstEmail = q.steps.find((s) => s.kind === "email")!;
      expect(hasOptOutLine(firstEmail.body ?? "")).toBe(true);
    }
  });
});
