import { describe, expect, it } from "vitest";
import {
  alertHref,
  alertKey,
  budgetThreshold,
  closeDatePassed,
  dataQualityGaps,
  docExpiring,
  docUnsigned,
  emailUnanswered,
  escalationDue,
  goLiveSlipped,
  hasExternalAttendee,
  highValueUnassigned,
  IMPLEMENTED_RULES,
  invoiceOverdueTier,
  meetingNeedsNotes,
  migrationStalled,
  missingNextStep,
  nextStepOverdue,
  NOOP_RULES,
  ourCommitmentState,
  r100ParticipationLapsing,
  registrationExpiring,
  renewalTier,
  repInactive,
  snoozedTooOften,
  staleBeyondSla,
  theirCommitmentPassed,
  unpublishedInterviews,
} from "../rules";
import { addBusinessDays, businessDaysBetween, businessHoursBetween, dayBounds, daysLeftInMonth, monthIndexSince, tzOffsetMs } from "../time";

const NY = "America/New_York";
const D = (s: string) => new Date(s);
// Wed 30 Sep 2026 15:00 UTC = 11:00 New York (EDT)
const NOW = D("2026-09-30T15:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("time helpers", () => {
  it("tz offset (EDT = -4h)", () => {
    expect(tzOffsetMs(NOW, NY)).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(NOW, "UTC")).toBe(0);
  });
  it("dayBounds in New York", () => {
    const { start, end } = dayBounds(NOW, NY);
    expect(start.toISOString()).toBe("2026-09-30T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T04:00:00.000Z");
  });
  it("business days skip weekends", () => {
    // Fri 25 Sep 17:00 NY → Mon 28 Sep 09:00 NY = 1 business day
    expect(businessDaysBetween(D("2026-09-25T21:00:00Z"), D("2026-09-28T13:00:00Z"), NY)).toBe(1);
    // Mon → Wed = 2
    expect(businessDaysBetween(D("2026-09-28T14:00:00Z"), NOW, NY)).toBe(2);
    expect(businessDaysBetween(NOW, NOW, NY)).toBe(0);
  });
  it("business hours count only the work window on weekdays", () => {
    // Fri 16:00 NY → Mon 11:00 NY with 9–18 = 2h (Fri) + 2h (Mon)
    expect(businessHoursBetween(D("2026-09-25T20:00:00Z"), D("2026-09-28T15:00:00Z"), NY, 9, 18)).toBeCloseTo(4);
  });
  it("addBusinessDays jumps the weekend", () => {
    expect(addBusinessDays(D("2026-09-25T15:00:00Z"), 1, NY).toISOString()).toBe("2026-09-28T15:00:00.000Z");
  });
  it("month helpers", () => {
    expect(daysLeftInMonth(NOW, NY)).toBe(0);
    expect(monthIndexSince(D("2026-07-15T00:00:00Z"), NOW)).toBe(2);
    expect(monthIndexSince(D("2026-09-01T00:00:00Z"), NOW)).toBe(0);
  });
});

describe("deal rules", () => {
  it("NS-01 missing next step or due date", () => {
    expect(missingNextStep({ nextStep: null, nextStepDueAt: NOW })).toBe(true);
    expect(missingNextStep({ nextStep: "  ", nextStepDueAt: NOW })).toBe(true);
    expect(missingNextStep({ nextStep: "Send terms", nextStepDueAt: null })).toBe(true);
    expect(missingNextStep({ nextStep: "Send terms", nextStepDueAt: NOW })).toBe(false);
  });
  it("NS-02 overdue next step", () => {
    expect(nextStepOverdue({ nextStepDueAt: days(1) }, NOW)).toBe(true);
    expect(nextStepOverdue({ nextStepDueAt: days(-1) }, NOW)).toBe(false);
    expect(nextStepOverdue({ nextStepDueAt: null }, NOW)).toBe(false);
  });
  it("NS-03 AT-06: 6 idle days in Hot (SLA 5) fires; uses the later of stage entry / last activity", () => {
    expect(staleBeyondSla({ stageEnteredAt: days(20), lastActivityAt: days(6) }, 5, NOW).stale).toBe(true);
    expect(staleBeyondSla({ stageEnteredAt: days(20), lastActivityAt: days(4) }, 5, NOW).stale).toBe(false);
    expect(staleBeyondSla({ stageEnteredAt: days(3), lastActivityAt: days(30) }, 5, NOW).stale).toBe(false);
    expect(staleBeyondSla({ stageEnteredAt: days(100) }, null, NOW).stale).toBe(false);
  });
  it("NS-03 business mode counts weekdays only", () => {
    // 6 calendar days back from Wed = Thu → 4 business days
    const r = staleBeyondSla({ stageEnteredAt: days(6) }, 5, NOW, { mode: "business", tz: NY });
    expect(r.idleDays).toBe(4);
    expect(r.stale).toBe(false);
  });
  it("NS-09 close date passed with 1 day grace", () => {
    expect(closeDatePassed({ expectedCloseDate: days(2) }, NOW)).toBe(true);
    expect(closeDatePassed({ expectedCloseDate: new Date(NOW.getTime() - 3_600_000) }, NOW)).toBe(false);
  });
  it("NS-15 high value unassigned after 4 business hours", () => {
    const base = { ownerId: null, muu: 20_000_000, priority: null, createdAt: D("2026-09-29T13:00:00Z") };
    expect(highValueUnassigned(base, NOW, { muuMin: 10_000_000, hours: 4 })).toBe(true);
    expect(highValueUnassigned({ ...base, ownerId: "u1" }, NOW, { muuMin: 10_000_000, hours: 4 })).toBe(false);
    expect(highValueUnassigned({ ...base, muu: 1000 }, NOW, { muuMin: 10_000_000, hours: 4 })).toBe(false);
    expect(highValueUnassigned({ ...base, muu: 1000, priority: "top10" }, NOW, { muuMin: 10_000_000, hours: 4 })).toBe(true);
  });
  it("NS-27 data-quality gaps", () => {
    expect(dataQualityGaps({ unit: "muu", muu: null, primaryContactId: null })).toEqual(["MUU", "primary contact"]);
    expect(dataQualityGaps({ unit: "usd", primaryContactId: "c", primaryContactEmailStatus: "invalid" })).toEqual(["deal value", "valid email for primary contact"]);
    expect(dataQualityGaps({ unit: "muu", muu: 5, primaryContactId: "c" })).toEqual([]);
    expect(dataQualityGaps({ unit: "activation", primaryContactId: "c" })).toEqual([]);
  });
});

describe("email / meetings / tasks", () => {
  it("NS-04 unanswered after 24 business hours", () => {
    const t = { awaitingReplyFrom: "us", lastMessageAt: D("2026-09-29T14:00:00Z") }; // Tue 10:00 NY → Tue 8h + Wed 2h = 10h
    expect(emailUnanswered(t, NOW, { hours: 24, tz: NY })).toBe(false);
    // Fri 10:00 NY → Fri 8h + Mon 9h + Tue 9h + Wed 2h = 28h (weekend excluded)
    expect(emailUnanswered({ ...t, lastMessageAt: D("2026-09-25T14:00:00Z") }, NOW, { hours: 24, tz: NY })).toBe(true);
  });
  it("NS-04 counts working hours only", () => {
    const t = { awaitingReplyFrom: "us", lastMessageAt: D("2026-09-24T13:00:00Z") }; // Thu 09:00 NY
    // Thu 9h + Fri 9h + Mon 9h = 27h ≥ 24
    expect(emailUnanswered(t, NOW, { hours: 24, tz: NY })).toBe(true);
    expect(emailUnanswered({ ...t, awaitingReplyFrom: "them" }, NOW, { hours: 24, tz: NY })).toBe(false);
  });
  it("NS-05 our commitment: due soon vs overdue; snoozed is quiet", () => {
    const base = { status: "open", owedBy: "us" };
    expect(ourCommitmentState({ ...base, dueAt: days(1) }, NOW)).toBe("overdue");
    expect(ourCommitmentState({ ...base, dueAt: days(-0.5) }, NOW)).toBe("due_soon");
    expect(ourCommitmentState({ ...base, dueAt: days(-3) }, NOW)).toBe(null);
    expect(ourCommitmentState({ ...base, dueAt: days(1), snoozedUntil: days(-1) }, NOW)).toBe(null);
    expect(ourCommitmentState({ ...base, owedBy: "them", dueAt: days(1) }, NOW)).toBe(null);
  });
  it("NS-06 their commitment + 2 days grace", () => {
    expect(theirCommitmentPassed({ status: "open", owedBy: "them", dueAt: days(3) }, NOW)).toBe(true);
    expect(theirCommitmentPassed({ status: "open", owedBy: "them", dueAt: days(1) }, NOW)).toBe(false);
    expect(theirCommitmentPassed({ status: "done", owedBy: "them", dueAt: days(9) }, NOW)).toBe(false);
  });
  it("NS-26 snoozed ≥ 3 times", () => {
    expect(snoozedTooOften({ status: "open", snoozeCount: 3 })).toBe(true);
    expect(snoozedTooOften({ status: "open", snoozeCount: 2 })).toBe(false);
    expect(snoozedTooOften({ status: "done", snoozeCount: 5 })).toBe(false);
  });
  it("NS-07 external meeting without notes", () => {
    const m = { endsAt: new Date(NOW.getTime() - 3 * 3_600_000), attendees: ["me@roundtable.io", "Jo <jo@reach.co.uk>"], transcriptId: null, hasNotes: false };
    const opts = { hours: 2, internalDomains: ["roundtable.io", "blockchainff.com"] };
    expect(hasExternalAttendee(m.attendees, opts.internalDomains)).toBe(true);
    expect(meetingNeedsNotes(m, NOW, opts)).toBe(true);
    expect(meetingNeedsNotes({ ...m, hasNotes: true }, NOW, opts)).toBe(false);
    expect(meetingNeedsNotes({ ...m, transcriptId: "t" }, NOW, opts)).toBe(false);
    expect(meetingNeedsNotes({ ...m, attendees: ["a@roundtable.io"] }, NOW, opts)).toBe(false);
    expect(meetingNeedsNotes({ ...m, endsAt: new Date(NOW.getTime() - 3_600_000) }, NOW, opts)).toBe(false);
  });
});

describe("documents, onboarding, R100, revenue", () => {
  it("NS-10 unsigned after 5 business days", () => {
    expect(docUnsigned({ type: "contract", status: "sent", createdAt: days(8) }, NOW, { businessDays: 5, tz: NY })).toBe(true);
    expect(docUnsigned({ type: "contract", status: "sent", createdAt: days(5) }, NOW, { businessDays: 5, tz: NY })).toBe(false);
    expect(docUnsigned({ type: "deck", status: "sent", createdAt: days(30) }, NOW, { businessDays: 5, tz: NY })).toBe(false);
    expect(docUnsigned({ type: "nda", status: "signed", createdAt: days(30) }, NOW, { businessDays: 5, tz: NY })).toBe(false);
  });
  it("NS-11 expiring within 30 days", () => {
    expect(docExpiring({ type: "nda", status: "signed", expiresAt: days(-10) }, NOW)).toBe(true);
    expect(docExpiring({ type: "nda", status: "signed", expiresAt: days(-40) }, NOW)).toBe(false);
    expect(docExpiring({ type: "nda", status: "signed", expiresAt: days(1) }, NOW)).toBe(false);
  });
  it("NS-19/20 migrations", () => {
    expect(migrationStalled({ stage: "qa", launched: false, stageEnteredAt: days(11) }, NOW)).toBe(true);
    expect(migrationStalled({ stage: "live", launched: false, stageEnteredAt: days(40) }, NOW)).toBe(false);
    expect(goLiveSlipped({ launched: false, targetGoLive: days(1) }, NOW)).toBe(true);
    expect(goLiveSlipped({ launched: true, targetGoLive: days(1) }, NOW)).toBe(false);
  });
  it("NS-21 participation lapsing only in the last 7 days of the month", () => {
    const r100 = { firstPostDate: "2026-07-10", participation: [true, true] };
    expect(r100ParticipationLapsing(r100, NOW, { tz: NY })).toBe(true); // month 3 (idx 2) missing
    expect(r100ParticipationLapsing({ ...r100, participation: [true, true, true] }, NOW, { tz: NY })).toBe(false);
    expect(r100ParticipationLapsing(r100, D("2026-09-10T15:00:00Z"), { tz: NY })).toBe(false);
    expect(r100ParticipationLapsing({ participation: [] }, NOW, { tz: NY })).toBe(false);
  });
  it("NS-22 interviews filmed but unpublished", () => {
    const cf = {
      interviews: [
        { id: "a", guest: "CEO", filmedDate: "2026-09-01", publishDate: "TBD" },
        { id: "b", filmedAt: "2026-09-01", publishedAt: "2026-09-10" },
        { id: "c", filmedAt: "2026-09-25" },
        { id: "d", filmedAt: "2026-08-01", status: "published" },
      ],
    };
    expect(unpublishedInterviews(cf, NOW).map((i) => i.key)).toEqual(["a"]);
    expect(unpublishedInterviews({}, NOW)).toEqual([]);
  });
  it("NS-23 invoice tiers", () => {
    expect(invoiceOverdueTier({ status: "sent", dueAt: days(20) }, NOW)).toBe(14);
    expect(invoiceOverdueTier({ status: "sent", dueAt: days(8) }, NOW)).toBe(7);
    expect(invoiceOverdueTier({ status: "sent", dueAt: days(1) }, NOW)).toBe(1);
    expect(invoiceOverdueTier({ status: "sent", dueAt: days(0.5) }, NOW)).toBe(null);
    expect(invoiceOverdueTier({ status: "paid", dueAt: days(20) }, NOW)).toBe(null);
  });
  it("NS-24 renewal tiers", () => {
    expect(renewalTier(days(-50), NOW)).toBe(60);
    expect(renewalTier(days(-20), NOW)).toBe(30);
    expect(renewalTier(days(-10), NOW)).toBe(14);
    expect(renewalTier(days(-90), NOW)).toBe(null);
    expect(renewalTier(days(1), NOW)).toBe(null);
  });
});

describe("people / system", () => {
  it("NS-25 rep inactivity in business days", () => {
    expect(repInactive(days(5), days(100), NOW, { businessDays: 2, tz: NY })).toBe(true);
    expect(repInactive(days(1), days(100), NOW, { businessDays: 2, tz: NY })).toBe(false);
    expect(repInactive(null, days(1), NOW, { businessDays: 2, tz: NY })).toBe(false);
  });
  it("NS-33 budget thresholds", () => {
    expect(budgetThreshold(400, 1000)).toBe(null);
    expect(budgetThreshold(500, 1000)).toBe(0.5);
    expect(budgetThreshold(850, 1000)).toBe(0.8);
    expect(budgetThreshold(1200, 1000)).toBe(1);
    expect(budgetThreshold(1200, 0)).toBe(null);
  });
  it("NS-16 registration expiring", () => {
    expect(registrationExpiring({ status: "approved", protectedUntil: days(-3) }, NOW)).toBe(true);
    expect(registrationExpiring({ status: "pending", protectedUntil: days(-3) }, NOW)).toBe(false);
  });
  it("escalation waits for business time and only fires on weekdays", () => {
    const a = { createdAt: D("2026-09-28T14:00:00Z"), state: "open" }; // Mon 10:00 NY
    expect(escalationDue(a, 24, NOW, { tz: NY })).toBe(true); // Wed: 2 business days ≥ 1
    expect(escalationDue(a, 48, NOW, { tz: NY })).toBe(true);
    expect(escalationDue({ ...a, createdAt: D("2026-09-29T14:00:00Z") }, 48, NOW, { tz: NY })).toBe(false);
    expect(escalationDue({ ...a, escalatedAt: NOW }, 24, NOW, { tz: NY })).toBe(false);
    expect(escalationDue({ ...a, state: "snoozed" }, 24, NOW, { tz: NY })).toBe(false);
    expect(escalationDue(a, null, NOW, { tz: NY })).toBe(false);
    // Saturday: never
    expect(escalationDue({ ...a, createdAt: D("2026-09-21T14:00:00Z") }, 24, D("2026-10-03T15:00:00Z"), { tz: NY })).toBe(false);
  });
});

describe("catalogue + keys", () => {
  it("every rule is either implemented or a documented no-op", () => {
    const all = Array.from({ length: 35 }, (_, i) => `NS-${String(i + 1).padStart(2, "0")}`);
    const covered = new Set<string>([...IMPLEMENTED_RULES, ...Object.keys(NOOP_RULES)]);
    expect(all.filter((c) => !covered.has(c))).toEqual([]);
  });
  it("dedupe key and deep links", () => {
    expect(alertKey({ ruleCode: "NS-01", entity: "deal", entityId: "x", recipientId: "u" })).toBe("NS-01|deal|x|u");
    expect(alertHref("deal", "abc#t30")).toBe("/deals/abc");
    expect(alertHref("task", "t1")).toBe("/tasks?task=t1");
  });
});
