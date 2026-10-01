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
  return { title: urgent ? `Today: ${urgent} item${urgent === 1 ? " needs" : "s need"} attention` : "Today: your plan for the day", body: lines.map((l) => `• ${l}`).join("\n") };
}

/**
 * Pure: final daily digest = Today lines + the "Bundled for you" section (alert-budget overflow, V2 §B3).
 * Titles always start with "Today" (the once-a-day dedupe matches on it). Null when there's nothing at all.
 */
export function composeDailyDigest(myDay: { title: string; body: string } | null, bundled: string | null): { title: string; body: string } | null {
  if (!myDay && !bundled) return null;
  return {
    title: myDay?.title ?? "Today: a few quiet updates bundled for you",
    body: [myDay?.body, bundled].filter(Boolean).join("\n\n"),
  };
}
