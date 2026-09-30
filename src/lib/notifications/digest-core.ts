/** Pure digest text builders (unit tested). */

export type DigestCounts = {
  overdueTasks: number;
  dueToday: number;
  commitmentsDue: number;
  meetingsToday: number;
  awaitingReply: number;
  dealsAtRisk: number;
  alerts: { critical: number; serious: number; warning: number; info: number };
};

/** Pure: digest text from counts (null when there's nothing to report). */
export function myDayDigestText(c: DigestCounts): { title: string; body: string } | null {
  const lines: string[] = [];
  if (c.overdueTasks) lines.push(`${c.overdueTasks} overdue task${c.overdueTasks === 1 ? "" : "s"}`);
  if (c.dueToday) lines.push(`${c.dueToday} due today${c.commitmentsDue ? ` (${c.commitmentsDue} commitment${c.commitmentsDue === 1 ? "" : "s"})` : ""}`);
  if (c.meetingsToday) lines.push(`${c.meetingsToday} meeting${c.meetingsToday === 1 ? "" : "s"} today — prep briefs ready`);
  if (c.dealsAtRisk) lines.push(`${c.dealsAtRisk} deal${c.dealsAtRisk === 1 ? "" : "s"} at risk`);
  if (c.awaitingReply) lines.push(`${c.awaitingReply} email${c.awaitingReply === 1 ? "" : "s"} awaiting your reply`);
  const a = c.alerts;
  const alertTotal = a.critical + a.serious + a.warning + a.info;
  if (alertTotal) {
    const parts = [a.critical && `${a.critical} critical`, a.serious && `${a.serious} serious`, a.warning && `${a.warning} warning`, a.info && `${a.info} info`].filter(Boolean);
    lines.push(`${alertTotal} open alert${alertTotal === 1 ? "" : "s"} (${parts.join(", ")})`);
  }
  if (!lines.length) return null;
  const urgent = c.overdueTasks + a.critical + a.serious;
  return { title: urgent ? `My Day: ${urgent} item${urgent === 1 ? " needs" : "s need"} attention` : "My Day: your plan for today", body: lines.map((l) => `• ${l}`).join("\n") };
}
