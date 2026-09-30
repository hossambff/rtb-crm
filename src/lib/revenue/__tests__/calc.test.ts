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
    expect(s.activeClosing).toEqual({ count: 2, cents: 170_00 }); // verbal + negotiation
    expect(s.currentAnnualized).toEqual({ count: 2, cents: 800_00 });
    expect(s.warmNegotiation).toEqual({ count: 0, cents: 0 });
    expect(s.upcomingCollections).toEqual({ count: 1, cents: 10, fromDealSchedule: 0 });
    expect(s.overdue).toEqual({ count: 1, cents: 5 });
  });

  // QA-08 / AT-10: the imported TheStreet book (docs/IMPORT_REPORT.md) must reproduce the Chris & Will Summary tab.
  it("reproduces the C&W TheStreet summary from the imported deals", () => {
    const mk = (id: string, stageKey: string, cv: number | null, av: number | null, np: number | null = null): AdsDeal => ({
      id,
      stageKey,
      contractValueCents: cv,
      annualizedValueCents: av,
      renewalAt: null,
      accountId: id,
      accountName: id,
      nextPaymentCents: np,
      nextPaymentAt: null,
    });
    const warm = [100_000, 90_000, 85_000, 80_000, 80_000, 75_000, 75_000, 75_000, 70_000, 70_000, 67_500, 60_000, 60_000, 115_000];
    const book: AdsDeal[] = [
      ...warm.map((v, i) => mk(`w${i}`, "warm", null, v * 100)),
      mk("n1", "negotiation", 60_000_00, null, 60_000_00),
      mk("n2", "negotiation", 50_000_00, null, 50_000_00),
      mk("v1", "verbal", 100_000_00, null, 100_000_00),
      mk("l1", "loi", 200_000_00, null, 200_000_00),
      ...[250_000, 200_000, 200_000, 150_000, 150_000, 100_000, 100_000].map((v, i) =>
        mk(`c${i}`, "current_client", v * 100, v * 100, [60_000, 50_000, 40_000, 40_000, 30_000, 20_000, 20_000][i]! * 100),
      ),
    ];
    const s = revenueSummary(book, [], now);
    expect(s.activeClosing).toEqual({ count: 4, cents: 410_000_00 });
    expect(s.currentAnnualized).toEqual({ count: 7, cents: 1_150_000_00 });
    expect(s.upcomingCollections).toEqual({ count: 7, cents: 260_000_00, fromDealSchedule: 7 });
    expect(s.warmNegotiation).toEqual({ count: 14, cents: 1_102_500_00 });
  });

  it("a current client's open invoice replaces its scheduled next payment; dated payments outside 60d are excluded", () => {
    const base = { contractValueCents: null, annualizedValueCents: 1_000_00, renewalAt: null, accountId: "x", accountName: "X" };
    const book: AdsDeal[] = [
      { ...base, id: "a", stageKey: "current_client", nextPaymentCents: 500_00, nextPaymentAt: null },
      { ...base, id: "b", stageKey: "current_client", nextPaymentCents: 300_00, nextPaymentAt: d("2027-03-01") },
      { ...base, id: "c", stageKey: "current_client", nextPaymentCents: 200_00, nextPaymentAt: d("2026-10-15") },
    ];
    const s = revenueSummary(book, [{ status: "scheduled", dueAt: d("2026-10-20"), amountCents: 450_00, dealId: "a" }], now);
    expect(s.upcomingCollections).toEqual({ count: 2, cents: 650_00, fromDealSchedule: 1 });
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
    expect(c.total).toBe(970_00); // negotiation now counts as an active deal
    expect(c.rows[0]!.name).toBe("B");
    expect(c.topShare).toBeCloseTo(800 / 970);
  });
});
