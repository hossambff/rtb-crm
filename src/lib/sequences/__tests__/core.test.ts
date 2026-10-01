import { describe, expect, it } from "vitest";
import {
  buildVariables,
  capDecision,
  computeMetrics,
  continuesThread,
  effectiveCap,
  evaluateExit,
  failuresFor,
  intentFor,
  isBounceSender,
  isUnsubscribeReply,
  isWithinWindow,
  makeMessageId,
  missingForSteps,
  nextWindowStart,
  normalizeSteps,
  normalizeWindow,
  referencesHeader,
  renderTemplate,
  retryDelayMs,
  scheduleAfter,
  sentMessageIds,
  subjectForStep,
  validateSequence,
  type HistoryEntry,
  type Step,
} from "../core";

const NY = normalizeWindow({ tz: "America/New_York", startHour: 9, endHour: 18 });
const LDN = normalizeWindow({ tz: "Europe/London", startHour: 8, endHour: 17 });

describe("renderTemplate", () => {
  it("substitutes known variables, tolerant of spacing and case", () => {
    const r = renderTemplate("Hi {{ first_name }}, love {{Company}}.", { first_name: "Ana", company: "TheStreet" });
    expect(r).toEqual({ text: "Hi Ana, love TheStreet.", missing: [] });
  });
  it("reports empty variables as missing and never leaves raw braces", () => {
    const r = renderTemplate("Hi {{first_name}},", { first_name: "  " });
    expect(r.missing).toEqual(["first_name"]);
    expect(r.text).not.toContain("{{");
  });
  it("treats unknown variables as missing", () => {
    expect(renderTemplate("{{nickname}}", {}).missing).toEqual(["nickname"]);
  });
  it("uses an explicit fallback", () => {
    expect(renderTemplate("Hi {{first_name|there}}", {})).toEqual({ text: "Hi there", missing: [] });
  });
  it("flags unbalanced braces", () => {
    expect(renderTemplate("Hi {{first_name", { first_name: "A" }).missing).toContain("{{…}}");
  });
});

describe("buildVariables / missingForSteps", () => {
  const steps: Step[] = normalizeSteps([
    { kind: "email", delayDays: 0, subject: "Idea for {{company}}", body: "Hi {{first_name}},\n{{opener}}" },
    { kind: "task", delayDays: 2, title: "Call {{full_name}}" },
  ]);
  it("blocks when the opener is missing", () => {
    const vars = buildVariables({ firstName: "Ana", fullName: "Ana Ruiz", company: "Acme" }, { name: "Will Smith" });
    expect(vars.sender_first_name).toBe("Will");
    expect(missingForSteps(steps, vars)).toEqual([{ step: 0, missing: ["opener"] }]);
    expect(missingForSteps(steps, { ...vars, opener: "Saw your piece." })).toEqual([]);
  });
  it("does not invent a first name", () => {
    const vars = buildVariables({ firstName: null, fullName: "Editorial team", company: "Acme" }, { name: "W" });
    expect(missingForSteps(steps, { ...vars, opener: "x" })[0]?.missing).toEqual(["first_name"]);
  });
});

describe("validateSequence / subjects", () => {
  it("requires a subject on the first email and known variables", () => {
    const errs = validateSequence(normalizeSteps([{ kind: "email", delayDays: 0, subject: "", body: "Hi {{nick}}" }]));
    expect(errs.join(" ")).toMatch(/subject/);
    expect(errs.join(" ")).toMatch(/\{\{nick\}\}/);
  });
  it("follow-ups reply in thread with Re: subject", () => {
    const steps = normalizeSteps([
      { kind: "email", delayDays: 0, subject: "Quick idea", body: "a" },
      { kind: "linkedin", delayDays: 1, title: "Connect" },
      { kind: "email", delayDays: 2, body: "b" },
      { kind: "email", delayDays: 2, subject: "New topic", body: "c", replyInThread: false },
    ]);
    expect(validateSequence(steps)).toEqual([]);
    expect(subjectForStep(steps, 0)).toBe("Quick idea");
    expect(subjectForStep(steps, 2)).toBe("Re: Quick idea");
    expect(continuesThread(steps, 2)).toBe(true);
    expect(continuesThread(steps, 0)).toBe(false);
    expect(subjectForStep(steps, 3)).toBe("New topic");
    expect(continuesThread(steps, 3)).toBe(false);
  });
});

describe("working-hours scheduling", () => {
  it("keeps an in-window instant", () => {
    const t = new Date("2026-10-01T15:00:00Z"); // Thu 11:00 New York
    expect(isWithinWindow(t, NY)).toBe(true);
    expect(nextWindowStart(t, NY)).toEqual(t);
  });
  it("moves an evening instant to 9:00 next business day in the sender's zone", () => {
    const fri = new Date("2026-10-02T23:30:00Z"); // Fri 19:30 New York
    expect(nextWindowStart(fri, NY).toISOString()).toBe("2026-10-05T13:00:00.000Z"); // Mon 09:00 EDT
  });
  it("moves an early-morning instant to the same day's start", () => {
    const early = new Date("2026-10-01T10:00:00Z"); // Thu 06:00 New York
    expect(nextWindowStart(early, NY).toISOString()).toBe("2026-10-01T13:00:00.000Z");
  });
  it("adds business days skipping weekends, in the sender's zone", () => {
    const thu = new Date("2026-10-01T15:00:00Z"); // Thu 11:00 NY
    expect(scheduleAfter(thu, 2, NY).toISOString()).toBe("2026-10-05T15:00:00.000Z"); // Mon 11:00
    expect(scheduleAfter(thu, 0, NY)).toEqual(thu);
  });
  it("is zone-aware: London sender at 17:30 local rolls to next morning", () => {
    const t = new Date("2026-10-01T16:30:00Z"); // 17:30 BST
    expect(isWithinWindow(t, LDN)).toBe(false);
    expect(nextWindowStart(t, LDN).toISOString()).toBe("2026-10-02T07:00:00.000Z"); // Fri 08:00 BST
  });
  it("handles a DST change (New York, Nov 2026)", () => {
    const fri = new Date("2026-10-30T22:30:00Z"); // Fri 18:30 EDT
    expect(nextWindowStart(fri, NY).toISOString()).toBe("2026-11-02T14:00:00.000Z"); // Mon 09:00 EST
  });
  it("normalizes broken windows and zones", () => {
    expect(normalizeWindow({ tz: "Mars/Base", startHour: 20, endHour: 8 })).toEqual({ tz: "America/New_York", startHour: 9, endHour: 18 });
  });
});

describe("caps & retries", () => {
  it("counts remaining sends", () => {
    expect(capDecision(39, 40)).toEqual({ allowed: true, remaining: 1 });
    expect(capDecision(40, 40).allowed).toBe(false);
    expect(effectiveCap(0)).toBe(1);
    expect(effectiveCap(10_000)).toBe(200);
  });
  it("backs off 15m, 1h, 4h", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([900_000, 3_600_000, 14_400_000]);
  });
});

describe("history ledger", () => {
  const h: HistoryEntry[] = [
    { step: 0, at: "a", kind: "email_intent", ok: false, note: "<m0>" },
    { step: 0, at: "b", kind: "email", ok: true, note: "<m0>" },
    { step: 1, at: "c", kind: "email_intent", ok: false, note: "<m1>" },
    { step: 1, at: "d", kind: "email_failed", ok: false },
    { step: 1, at: "e", kind: "retry", ok: true },
    { step: 1, at: "f", kind: "email_failed", ok: false },
  ];
  it("finds intents, failures since retry, and references", () => {
    expect(intentFor(h, 1)?.note).toBe("<m1>");
    expect(intentFor(h, 2)).toBeNull();
    expect(failuresFor(h, 1)).toBe(1);
    expect(sentMessageIds(h)).toEqual(["<m0>"]);
    expect(referencesHeader(["<a>", "<b>", "<a>"])).toBe("<a> <b>");
    expect(referencesHeader([])).toBeNull();
  });
  it("makes searchable, header-safe Message-IDs", () => {
    expect(makeMessageId("1b2c-3d", 2, "ab\r\ncd")).toBe("<seq.1b2c-3d.2.abcd@rtb-sales-os>");
  });
});

describe("evaluateExit", () => {
  it("always honors do-not-contact and unsubscribe, even with toggles off", () => {
    const off = { reply: false, meetingBooked: false, stageChange: false, unsubscribe: false };
    expect(evaluateExit(off, { doNotContact: true })).toBe("do_not_contact");
    expect(evaluateExit(off, { suppressed: true })).toBe("do_not_contact");
    expect(evaluateExit(off, { unsubscribeReply: true, replied: true })).toBe("unsubscribed");
    expect(evaluateExit(off, { bounced: true })).toBe("bounced");
    expect(evaluateExit(off, { replied: true, meetingBooked: true, stageChanged: true })).toBeNull();
  });
  it("applies reply / meeting / stage rules", () => {
    const on = { reply: true, meetingBooked: true, stageChange: true };
    expect(evaluateExit(on, { replied: true })).toBe("replied");
    expect(evaluateExit(on, { meetingBooked: true })).toBe("meeting_booked");
    expect(evaluateExit(on, { stageChanged: true })).toBe("stage_changed");
    expect(evaluateExit(on, { dealClosed: true })).toBe("deal_closed");
    expect(evaluateExit(on, {})).toBeNull();
  });
});

describe("reply classification", () => {
  it("detects unsubscribe requests and bounce senders", () => {
    expect(isUnsubscribeReply("Please remove me from your list")).toBe(true);
    expect(isUnsubscribeReply("Sounds great, let's talk Tuesday")).toBe(false);
    expect(isBounceSender("Mail Delivery Subsystem <mailer-daemon@googlemail.com>")).toBe(true);
    expect(isBounceSender("ana@acme.com")).toBe(false);
  });
});

describe("computeMetrics", () => {
  it("aggregates statuses and exit reasons", () => {
    const m = computeMetrics([
      { status: "active", exitReason: null, n: 5 },
      { status: "exited", exitReason: "replied", n: 3 },
      { status: "exited", exitReason: "meeting_booked", n: 1 },
      { status: "exited", exitReason: "bounced", n: 1 },
    ]);
    expect(m).toMatchObject({ enrolled: 10, active: 5, replied: 3, meetings: 1, bounced: 1 });
    expect(m.replyRate).toBeCloseTo(0.3);
  });
});
