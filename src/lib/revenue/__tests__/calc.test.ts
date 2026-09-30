import { describe, expect, it } from "vitest";
import { arAging, concentration, effectiveStatus, renewalsDue, revenueSummary, type AdsDeal } from "../calc";

const now = new Date("2026-09-30T12:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("revenue calc", () => {
  it("unpaid past-due invoices are overdue", () => {
    expect(effectiveStatus({ status: "sent", dueAt: d("2026-09-01") }, now)).toBe("overdue");
    expect(effectiveStatus({ status: "paid", dueAt: d("2026-09-01") }, now)).toBe("paid");
    expect(effectiveStatus({ status: "scheduled", dueAt: d("2026-10-10") }, now)).toBe("scheduled");
  });

  it("AR aging buckets", () => {
    const rows = arAging(
      [
        { status: "sent", dueAt: d("2026-09-20"), amountCents: 100 },
        { status: "sent", dueAt: d("2026-08-15"), amountCents: 200 },
        { status: "scheduled", dueAt: d("2026-07-20"), amountCents: 300 },
        { status: "sent", dueAt: d("2026-05-01"), amountCents: 400 },
        { status: "paid", dueAt: d("2026-05-01"), amountCents: 999 },
      ],
      now,
    );
    expect(rows.map((r) => r.cents)).toEqual([100, 200, 300, 400]);
  });

  const deals: AdsDeal[] = [
    { id: "1", stageKey: "verbal", contractValueCents: 100_00, annualizedValueCents: null, renewalAt: null, accountId: "a", accountName: "A" },
    { id: "2", stageKey: "current_client", contractValueCents: 50_00, annualizedValueCents: 600_00, renewalAt: d("2026-10-10"), accountId: "b", accountName: "B" },
    { id: "3", stageKey: "negotiation", contractValueCents: 70_00, annualizedValueCents: null, renewalAt: null, accountId: "c", accountName: "C" },
    { id: "4", stageKey: "renewal", contractValueCents: null, annualizedValueCents: 200_00, renewalAt: d("2026-11-20"), accountId: "b", accountName: "B" },
  ];

  it("exec summary widgets", () => {
    const s = revenueSummary(deals, [{ status: "scheduled", dueAt: d("2026-11-01"), amountCents: 10 }, { status: "sent", dueAt: d("2026-09-01"), amountCents: 5 }], now);
    expect(s.activeClosing).toEqual({ count: 1, cents: 100_00 });
    expect(s.currentAnnualized).toEqual({ count: 2, cents: 800_00 });
    expect(s.warmNegotiation).toEqual({ count: 1, cents: 70_00 });
    expect(s.upcomingCollections).toEqual({ count: 1, cents: 10 });
    expect(s.overdue).toEqual({ count: 1, cents: 5 });
  });

  it("renewal windows 14/30/60", () => {
    const r = renewalsDue(deals, now);
    expect(r.map((x) => [x.deal.id, x.window])).toEqual([
      ["2", 14],
      ["4", 60],
    ]);
  });

  it("customer concentration", () => {
    const c = concentration(deals);
    expect(c.total).toBe(900_00);
    expect(c.rows[0]!.name).toBe("B");
    expect(c.topShare).toBeCloseTo(800 / 900);
  });
});
