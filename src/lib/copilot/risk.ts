/** Pure deal-risk heuristics shared by list_my_work(deals_at_risk) and quick actions (unit-tested). */

export type RiskInput = {
  status: string;
  stageCategory: string;
  slaDays: number | null;
  stageEnteredAt: Date | null;
  lastActivityAt: Date | null;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  expectedCloseDate: Date | null;
  healthScore: number | null;
};

const DAY = 86_400_000;

export function dealRiskReasons(d: RiskInput, now: Date = new Date()): string[] {
  if (d.status !== "open" || d.stageCategory !== "open") return [];
  const reasons: string[] = [];
  if (!d.nextStep || !d.nextStepDueAt) reasons.push("No next step with a due date");
  else if (d.nextStepDueAt.getTime() < now.getTime()) reasons.push(`Next step overdue by ${Math.ceil((now.getTime() - d.nextStepDueAt.getTime()) / DAY)}d`);
  if (d.slaDays) {
    const since = d.lastActivityAt ?? d.stageEnteredAt;
    if (since) {
      const idle = Math.floor((now.getTime() - since.getTime()) / DAY);
      if (idle > d.slaDays) reasons.push(`No activity for ${idle}d (stage SLA ${d.slaDays}d)`);
    }
  }
  if (d.expectedCloseDate && d.expectedCloseDate.getTime() < now.getTime()) reasons.push("Expected close date has passed");
  if (d.healthScore != null && d.healthScore < 50) reasons.push(`Health score ${d.healthScore}`);
  return reasons;
}
