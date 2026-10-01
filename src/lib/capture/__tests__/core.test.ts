import { describe, expect, it } from "vitest";
import { detectTarget, normalizeAiCapture, parseCaptureHeuristic, segments } from "../core";

const now = new Date("2026-10-01T15:00:00Z"); // Thursday

describe("segments", () => {
  it("splits inline dictation on markers", () => {
    const s = segments("Great call with Jane todo send the deck by Friday next step demo on Tuesday");
    expect(s).toEqual([
      { marker: null, text: "Great call with Jane" },
      { marker: "todo", text: "send the deck by Friday" },
      { marker: "next step", text: "demo on Tuesday" },
    ]);
  });
  it("handles lines, checkboxes and follow-up phrasing", () => {
    const s = segments("Met the CRO.\n- [ ] intro to legal\nFollow up with Sam about traffic data.");
    expect(s.map((x) => x.marker)).toEqual([null, "todo", "follow up with"]);
    expect(s[2]!.text).toBe("Follow up with Sam about traffic data");
  });
});

describe("parseCaptureHeuristic", () => {
  it("extracts note, tasks with due dates, next step and fields", () => {
    const p = parseCaptureHeuristic(
      "Call with Reach went well, they have 2.5M monthly uniques.\nTodo: send the pro forma by Friday\nTask: loop in onboarding\nNext step: legal review next week\nClose date: 2026-12-15",
      now,
    );
    expect(p.engine).toBe("heuristic");
    expect(p.note).toMatch(/Call with Reach went well/);
    expect(p.note).not.toMatch(/Todo/i);
    expect(p.tasks.map((t) => t.title)).toEqual(["Send the pro forma by Friday", "Loop in onboarding"]);
    expect(p.tasks[0]!.due).toBe("2026-10-02T17:00:00.000Z");
    expect(p.nextStep?.text).toBe("Legal review next week");
    expect(p.nextStep?.due).not.toBeNull();
    expect(p.fieldUpdates.find((f) => f.field === "muu")?.value).toBe("2500000");
    expect(p.fieldUpdates.find((f) => f.field === "expected_close_date")?.value).toBe("2026-12-15T17:00:00.000Z");
  });
  it("plain notes stay notes", () => {
    const p = parseCaptureHeuristic("Quick sync, nothing new.", now);
    expect(p).toMatchObject({ note: "Quick sync, nothing new.", tasks: [], nextStep: null, fieldUpdates: [] });
  });
  it("resolves relative close dates", () => {
    expect(parseCaptureHeuristic("They'll close next quarter.", now).fieldUpdates[0]?.value).toBe("2027-03-31T17:00:00.000Z");
  });
  it("dedupes repeated tasks", () => {
    expect(parseCaptureHeuristic("todo: send deck. todo: Send deck", now).tasks).toHaveLength(1);
  });
});

describe("normalizeAiCapture", () => {
  it("grounds numbers and sanitizes dates", () => {
    const p = normalizeAiCapture(
      {
        note: "Reach has 2.5M MUU.",
        tasks: [{ title: "send the deck", due: "2026-10-03" }, { title: "x", due: null }, { title: "Ancient task", due: "1999-01-01" }],
        next_step: { text: "legal review", due: null },
        muu: 2_500_000,
        expected_close_date: "2099-01-01",
        deal_or_account_hint: "Reach",
      },
      "Reach has 2.5M monthly uniques",
      now,
      "google/gemini-2.5-flash",
    );
    expect(p.engine).toBe("ai:google/gemini-2.5-flash");
    expect(p.tasks.map((t) => t.title)).toEqual(["Send the deck", "Ancient task"]);
    expect(p.tasks[1]!.due).toBeNull();
    expect(p.fieldUpdates.map((f) => f.field)).toEqual(["muu"]);
    expect(p.nextStep?.text).toBe("Legal review");
  });
  it("drops an MUU the note never mentioned", () => {
    const p = normalizeAiCapture({ note: "n", tasks: [], next_step: null, muu: 9_000_000, expected_close_date: null, deal_or_account_hint: null }, "Nice chat", now, "m");
    expect(p.fieldUpdates).toEqual([]);
  });
});

describe("detectTarget", () => {
  const cands = [
    { kind: "deal" as const, id: "d1", name: "TheStreet — NET", accountName: "TheStreet", mine: true },
    { kind: "deal" as const, id: "d2", name: "Street Media", accountName: "Street Media" },
    { kind: "account" as const, id: "a1", name: "Reach plc" },
  ];
  it("matches whole names, prefers longer and own deals", () => {
    expect(detectTarget("Call with TheStreet about pricing", cands)?.id).toBe("d1");
    expect(detectTarget("Spoke to Street Media today", cands)?.id).toBe("d2");
    expect(detectTarget("reach plc wants a demo", cands)?.id).toBe("a1");
    expect(detectTarget("Streets ahead", cands)).toBeNull();
  });
});
