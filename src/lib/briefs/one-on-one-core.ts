/**
 * Manager 1:1 prep (docs/V2_SPEC.md §C8) — pure, client-safe, unit-tested core: who may prep for whom, the comparison
 * windows, activity deltas, and the heuristic coaching prompts used when AI is off or fails.
 */

const DAY = 86_400_000;

/* ───────────── Access ───────────── */

/** Roles that may prep a 1:1 for anyone (company-wide view). */
export const PREP_ALL_ROLES = ["executive", "admin", "super_admin"] as const;

export type PrepViewer = { id: string; role: string; teamId: string | null };
export type PrepTarget = { id: string; managerId: string | null; teamId: string | null; role: string };

/**
 * Executives/admins → everyone; sales leaders → their team (same team) + direct reports; anyone else → only their
 * direct reports (user.managerId). Never yourself, never pending users.
 */
export function canPrepFor(viewer: PrepViewer, target: PrepTarget): boolean {
  if (viewer.id === target.id || target.role === "pending") return false;
  if ((PREP_ALL_ROLES as readonly string[]).includes(viewer.role)) return true;
  if (target.managerId === viewer.id) return true;
  if (viewer.role === "sales_leader" && viewer.teamId != null && target.teamId === viewer.teamId) return true;
  return false;
}

/* ───────────── Windows & deltas ───────────── */

export type Window = { start: Date; end: Date };

/** "This week" = the trailing 7 days up to `now`; "last week" = the 7 days before that (same length, fair compare). */
export function briefWindows(now: Date): { current: Window; prior: Window } {
  const end = now.getTime();
  return {
    current: { start: new Date(end - 7 * DAY), end: new Date(end) },
    prior: { start: new Date(end - 14 * DAY), end: new Date(end - 7 * DAY) },
  };
}

export const ACTIVITY_KINDS = ["email", "call", "meeting", "linkedin", "note"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = { email: "Emails", call: "Calls", meeting: "Meetings", linkedin: "LinkedIn", note: "Notes" };
export type ActivityCounts = Partial<Record<string, number>>;

export type ActivityDelta = { kind: ActivityKind | "total"; label: string; current: number; prior: number; delta: number; pct: number | null };

/** Per-kind and total activity this week vs last week. pct = null when last week was 0. */
export function activityDeltas(current: ActivityCounts, prior: ActivityCounts): ActivityDelta[] {
  const row = (kind: ActivityKind | "total", label: string, c: number, p: number): ActivityDelta => ({
    kind,
    label,
    current: c,
    prior: p,
    delta: c - p,
    pct: p > 0 ? (c - p) / p : null,
  });
  const n = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, Math.round(v as number)) : 0);
  const rows = ACTIVITY_KINDS.map((k) => row(k, ACTIVITY_KIND_LABELS[k], n(current[k]), n(prior[k])));
  const total = row(
    "total",
    "Total",
    rows.reduce((a, r) => a + r.current, 0),
    rows.reduce((a, r) => a + r.prior, 0),
  );
  return [...rows, total];
}

/* ───────────── Brief content ───────────── */

export type BriefDeal = { id: string; name: string; pipeline: string; valueUsd: number; detail?: string | null; restricted?: boolean };

export type OneOnOneMetrics = {
  won: BriefDeal[];
  lost: BriefDeal[];
  advanced: BriefDeal[];
  slipped: BriefDeal[];
  created: BriefDeal[];
  closeDatePushes: BriefDeal[];
  overdueNextSteps: BriefDeal[];
  overdueTasks: { count: number; top: { id: string; title: string; dueAt: string | null; dealName: string | null }[] };
  activity: ActivityDelta[];
  openDeals: { count: number; valueUsd: number };
  risks: (BriefDeal & { health: number | null })[];
};

export type OneOnOneContent = {
  version: 1;
  repId: string;
  repName: string;
  generatedAt: string;
  window: { start: string; end: string };
  metrics: OneOnOneMetrics;
  headline: string;
  coachingPrompts: string[];
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** One-line summary of the week (heuristic; the AI may replace it). */
export function heuristicHeadline(repName: string, m: OneOnOneMetrics): string {
  const parts: string[] = [];
  if (m.won.length) parts.push(`won ${plural(m.won.length, "deal")}`);
  if (m.advanced.length) parts.push(`advanced ${m.advanced.length}`);
  if (m.slipped.length) parts.push(`${m.slipped.length} slipped`);
  if (m.lost.length) parts.push(`lost ${m.lost.length}`);
  const total = m.activity.find((a) => a.kind === "total");
  const act = total ? `${total.current} ${total.current === 1 ? "activity" : "activities"}${total.pct != null ? ` (${total.delta >= 0 ? "+" : ""}${Math.round(total.pct * 100)}% vs last week)` : ""}` : "";
  const what = parts.length ? parts.join(", ") : "no stage movement";
  return `${first(repName)}: ${what}; ${act || "no logged activity"}.`;
}

/**
 * Three concrete coaching prompts from the numbers, most pressing first; generic prompts fill the gaps.
 * Deterministic so the fallback is stable and testable.
 */
export function heuristicCoaching(m: OneOnOneMetrics): string[] {
  const out: string[] = [];
  const total = m.activity.find((a) => a.kind === "total");
  if (total && total.prior >= 5 && total.pct != null && total.pct <= -0.3) {
    out.push(`Activity is down ${Math.round(-total.pct * 100)}% vs last week (${total.prior} → ${total.current}). What got in the way, and what would help?`);
  }
  const risk = m.risks.find((r) => !r.restricted);
  if (risk) out.push(`What would it take to get ${risk.name} back on track${risk.health != null ? ` (health ${risk.health})` : ""}?`);
  if (m.overdueNextSteps.length >= 2) out.push(`${plural(m.overdueNextSteps.length, "deal")} have an overdue or missing next step — agree one concrete next step and date for each.`);
  if (m.closeDatePushes.length >= 2) out.push(`Close dates moved on ${plural(m.closeDatePushes.length, "deal")} this week. What is really driving the timeline?`);
  if (m.overdueTasks.count >= 3) out.push(`${plural(m.overdueTasks.count, "task")} are overdue. Which can be done, delegated or dropped this week?`);
  const lost = m.lost.find((d) => !d.restricted);
  if (lost) out.push(`What did we learn from losing ${lost.name}? Anything worth adding to the playbook?`);
  const won = m.won.find((d) => !d.restricted);
  if (won) out.push(`Great win on ${won.name} — what worked that the team could reuse? Worth sharing the story.`);
  if (m.slipped.length) out.push(`${plural(m.slipped.length, "deal")} moved backward. Are they still qualified, or should they go to nurture?`);
  const meetings = m.activity.find((a) => a.kind === "meeting");
  if (meetings && meetings.current === 0 && meetings.prior > 0) out.push("No meetings this week (vs " + meetings.prior + " last week). What's the plan to get in front of buyers?");
  for (const g of [
    "Which deal would you most like help with this week, and what kind of help?",
    "Where are you blocked on someone inside RTB?",
    "What's one thing to stop doing to free up selling time?",
  ]) {
    if (out.length >= 3) break;
    out.push(g);
  }
  return out.slice(0, 3);
}

/** Sanity-check AI prompts: 3 non-empty, de-duplicated, ≤ 300 chars; falls back to the heuristic for gaps. */
export function mergeCoaching(ai: string[] | null | undefined, fallback: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(ai ?? []), ...fallback]) {
    const t = p.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

/** Every deal id a stored brief mentions (for the on-read access re-check). */
export function briefDealIds(m: OneOnOneMetrics): string[] {
  const all = [...m.won, ...m.lost, ...m.advanced, ...m.slipped, ...m.created, ...m.closeDatePushes, ...m.overdueNextSteps, ...m.risks];
  return Array.from(new Set(all.map((d) => d.id)));
}

const GONE = "A deal you can no longer see";

/**
 * SEC L-3 / QA C8: a cached or past brief is re-filtered on every read — deals the viewer has lost access to since it
 * was generated (removed from an access list, deal or account restricted later) are anonymized, and fields hidden from
 * the viewer's role now (next step, close date, health) are stripped. Names of anonymized deals are also scrubbed from
 * the headline and coaching prompts.
 */
export function refilterBrief(c: OneOnOneContent, visible: ReadonlySet<string>, hidden: ReadonlySet<string>): OneOnOneContent {
  const all = hidden.has("*");
  const nextHidden = all || hidden.has("nextStep");
  const closeHidden = all || hidden.has("expectedCloseDate");
  const healthHidden = all || hidden.has("healthScore");
  const gone = new Set<string>();
  const fix = <T extends BriefDeal>(d: T): T => {
    if (visible.has(d.id)) return d;
    if (d.name && d.name !== GONE) gone.add(d.name);
    return { ...d, name: GONE, detail: null, restricted: true };
  };
  const m = c.metrics;
  const metrics: OneOnOneMetrics = {
    ...m,
    won: m.won.map(fix),
    lost: m.lost.map(fix),
    advanced: m.advanced.map(fix),
    slipped: m.slipped.map(fix),
    created: m.created.map(fix),
    closeDatePushes: closeHidden ? [] : m.closeDatePushes.map(fix),
    overdueNextSteps: m.overdueNextSteps.map((d) => {
      const f = fix(d);
      return nextHidden && f.detail ? { ...f, detail: "Next step overdue or missing" } : f;
    }),
    risks: m.risks.map((d) => {
      const f = fix(d);
      return healthHidden ? { ...f, health: null, detail: f.detail ? f.detail.replace(/health \d+(, )?/i, "").replace(/·\s*$/, "").trim() || null : null } : f;
    }),
  };
  const scrub = (t: string) => [...gone].reduce((acc, n) => (n.length >= 3 ? acc.split(n).join("a deal") : acc), t);
  return { ...c, metrics, headline: scrub(c.headline), coachingPrompts: c.coachingPrompts.map(scrub) };
}
