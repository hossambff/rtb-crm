/**
 * Collision warnings (V2 §C4) — pure helpers, client-safe and unit tested.
 * "Chris emailed this publisher 2 days ago": other people's touches on the same account. Only names, kinds and dates —
 * never subjects or bodies (restricted records and private threads stay invisible upstream).
 */

export type TouchKind = "email" | "call" | "meeting" | "linkedin" | "note";

/** One aggregated touch: the latest touch of `kind` by `userId` in the window, plus how many there were. */
export type RecentTouch = {
  userId: string;
  userName: string;
  userImage?: string | null;
  kind: TouchKind;
  /** ISO instant of the latest touch (may be in the future for an upcoming meeting). */
  at: string;
  count: number;
};

export type TouchRow = { userId: string | null; userName: string | null; userImage?: string | null; kind: string; at: Date | string | null; count?: number };

export const TOUCH_KINDS: readonly TouchKind[] = ["email", "call", "meeting", "linkedin", "note"];
/**
 * Kinds that count as "talking to the publisher" for collision warnings (QA MIN-16): an internal note is not a touch of
 * the customer, so it never raises a collision. Notes stay in the account's "Who's talking to them" timeline.
 */
export const COLLISION_KINDS: readonly TouchKind[] = TOUCH_KINDS.filter((k) => k !== "note");

const isKind = (k: string): k is TouchKind => (TOUCH_KINDS as readonly string[]).includes(k);

/**
 * Merge touch rows from several sources (activities, email threads, meetings) into one row per user × kind
 * (latest instant, summed counts), newest first. Rows without a user, kind or valid date are dropped; `excludeUserId`
 * removes the caller's own touches.
 */
export function mergeTouches(rows: TouchRow[], opts: { excludeUserId?: string | null } = {}): RecentTouch[] {
  const by = new Map<string, RecentTouch>();
  for (const r of rows) {
    if (!r.userId || !isKind(r.kind) || !r.at) continue;
    if (opts.excludeUserId && r.userId === opts.excludeUserId) continue;
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime())) continue;
    const key = `${r.userId}:${r.kind}`;
    const prev = by.get(key);
    const count = Math.max(1, r.count ?? 1);
    if (!prev) {
      by.set(key, { userId: r.userId, userName: r.userName?.trim() || "Someone", userImage: r.userImage ?? null, kind: r.kind, at: at.toISOString(), count });
    } else {
      prev.count += count;
      if (at.getTime() > new Date(prev.at).getTime()) prev.at = at.toISOString();
      if (!prev.userImage && r.userImage) prev.userImage = r.userImage;
    }
  }
  return [...by.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || a.userName.localeCompare(b.userName));
}

/** Collapse per-kind rows to one line per person (their latest touch wins), newest first. */
export function latestPerPerson(touches: RecentTouch[]): (RecentTouch & { kinds: TouchKind[]; total: number })[] {
  const by = new Map<string, RecentTouch & { kinds: TouchKind[]; total: number }>();
  for (const t of touches) {
    const prev = by.get(t.userId);
    if (!prev) by.set(t.userId, { ...t, kinds: [t.kind], total: t.count });
    else {
      prev.total += t.count;
      if (!prev.kinds.includes(t.kind)) prev.kinds.push(t.kind);
      if (new Date(t.at).getTime() > new Date(prev.at).getTime()) Object.assign(prev, { kind: t.kind, at: t.at, count: t.count });
    }
  }
  return [...by.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** "this publisher" / "this advertiser" / "this company" / "this account" from the account type. */
export function accountNoun(type: string | null | undefined): string {
  switch (type) {
    case "publisher":
    case "media_group":
      return "this publisher";
    case "advertiser":
    case "agency":
      return "this advertiser";
    case "public_company":
    case "token_project":
      return "this company";
    case "partner":
      return "this partner";
    default:
      return "this account";
  }
}

const PAST_VERB: Record<TouchKind, string> = {
  email: "emailed",
  call: "called",
  meeting: "met with",
  linkedin: "messaged",
  note: "logged a note on",
};

/** Calendar-day distance in words: "today", "yesterday", "2 days ago", "in 3 days". */
export function dayPhrase(at: Date, now: Date): string {
  const DAY = 86_400_000;
  const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diff = Math.round((startOf(now) - startOf(at)) / DAY);
  if (diff === 0) return at.getTime() > now.getTime() ? "later today" : "today";
  if (diff === 1) return "yesterday";
  if (diff === -1) return "tomorrow";
  if (diff > 1) return `${diff} days ago`;
  return `in ${-diff} days`;
}

/** "Chris emailed this publisher 2 days ago" · upcoming meeting → "Chris meets this publisher in 2 days". */
export function describeTouch(t: Pick<RecentTouch, "userName" | "kind" | "at">, now: Date, noun = "this account"): string {
  const first = t.userName.trim().split(/\s+/)[0] || "Someone";
  const at = new Date(t.at);
  if (t.kind === "meeting" && at.getTime() > now.getTime()) return `${first} meets ${noun} ${dayPhrase(at, now)}`;
  return `${first} ${PAST_VERB[t.kind]} ${noun} ${dayPhrase(at, now)}`;
}

/** One-line collision warning for a header: the most recent other-person touch + "and N others". Null when clear. */
export function collisionHeadline(touches: RecentTouch[], now: Date, noun = "this account"): string | null {
  const people = latestPerPerson(touches);
  const top = people[0];
  if (!top) return null;
  const rest = people.length - 1;
  return `${describeTouch(top, now, noun)}${rest > 0 ? ` · ${rest} other${rest === 1 ? "" : "s"} in touch too` : ""}`;
}
