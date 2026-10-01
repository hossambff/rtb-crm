/**
 * Deterministic natural-language parser for ⌘K commands (V2 A8). Pure + client-safe; unit tested.
 * Handles the common patterns ("move all NET deals idle more than 30 days to Nurture", "assign these 40 leads to Will",
 * "tag my overdue ENT deals as q4-push", "show deals with no next step"). Anything it can't place is returned as
 * `leftovers` so the server can ask the AI (aiObject + zod) — and the preview always shows what will actually run.
 */
import type { Command, DealFilter, ParseOutcome } from "./types";

export type Vocab = {
  pipelines: { key: string; name: string }[];
  stages: { pipelineKey: string; key: string; name: string; category: "open" | "won" | "lost" | "hold" }[];
  users: { id: string; name: string }[];
  meId: string;
  /** Deal ids currently selected on /deals ("these", "selected"). */
  selection?: string[];
};

const PIPELINE_ALIASES: Record<string, string[]> = {
  NET: ["netdev", "network", "network development", "publisher", "publishers"],
  ENT: ["enterprise"],
  SPT: ["sports", "sport"],
  R100: ["r100", "roundtable 100", "rtb100", "rtb 100"],
  ADS: ["sponsorship", "sponsorships", "thestreet ads"],
  PAY: ["payments"],
};
/** Keys that are also common English words: only matched in CAPS (or followed by "deals"/"pipeline"). */
const AMBIGUOUS_KEYS = new Set(["PAY", "ADS"]);

const FILLER = new Set(
  "a an all any every each the my mine our deals deal leads lead opportunities opportunity opps opp records accounts ones that which who are is be been being have has had with without for of in on at to from by and or than more over days day weeks week months month currently still right now please just them those these selected stage stages pipeline pipelines open".split(
    " ",
  ),
);

const UNIT_DAYS: Record<string, number> = { d: 1, day: 1, days: 1, w: 7, wk: 7, wks: 7, week: 7, weeks: 7, m: 30, mo: 30, month: 30, months: 30 };

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(s: string) {
  return s
    .replace(/[“”"]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split "verb subject preposition target" for the supported verbs. */
function splitVerb(text: string): { verb: Command["verb"]; subject: string; target?: string } | null {
  // NB: the close-date pattern must run before "move … to …".
  const t = text.replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:re-?assign|assign|give|hand(?:\s+over)?|transfer)\s+(.+)\s+to\s+(.+)$/i))) return { verb: "assign", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:set|push|move|change|update)\s+(?:the\s+)?(?:expected\s+)?close(?:\s+dates?)?\s+(?:of|for|on)\s+(.+)\s+to\s+(.+)$/i))) return { verb: "close", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:mark|set)\s+(.+?)\s+as\s+(won|lost|on hold|hold|closed lost|closed won)$/i))) return { verb: "move", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:move|shift|push|change|set|put)\s+(.+)\s+(?:to|into)\s+(?:the\s+)?(?:stage\s+)?(.+?)(?:\s+stage)?$/i))) return { verb: "move", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:add|apply)\s+(?:the\s+)?tag\s+["']?([\w-]+(?:\s[\w-]+)?)["']?\s+to\s+(.+)$/i))) return { verb: "tag", subject: m[2]!, target: m[1]! };
  if ((m = t.match(/^(?:tag|label)\s+(.+)\s+(?:as|with)\s+["']?(.+?)["']?$/i))) return { verb: "tag", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:enrol|enroll|add)\s+(.+)\s+(?:in|into|to|on)\s+(?:the\s+)?(?:sequence\s+)?["']?(.+?)["']?(?:\s+sequence)?$/i))) return { verb: "enroll", subject: m[1]!, target: m[2]! };
  if ((m = t.match(/^(?:show|find|list|select|filter|open|which|what)\s+(?:me\s+)?(?:are\s+)?(.+)$/i))) return { verb: "show", subject: m[1]! };
  return null;
}

/** Parse the subject phrase into a filter. Returns the words it could not place. */
export function parseSubject(subjectRaw: string, v: Vocab): { filter: DealFilter; leftovers: string[] } {
  const f: DealFilter = {};
  let s = ` ${norm(subjectRaw)} `;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (m) {
      fn(m);
      s = s.replace(m[0], " ");
      return true;
    }
    return false;
  };

  // Quoted text / "named X" → name contains
  take(/\s(?:named|called|matching|containing)\s+"([^"]+)"/i, (m) => (f.text = m[1]!.trim()));
  take(/\s(?:named|called|matching|containing)\s+([\w.&'-]+)/i, (m) => (f.text = m[1]!.trim()));
  // Selection
  // "these"/"selected" means the /deals selection — and nothing else: without a selection it matches no records.
  if (take(/\s(?:these|selected|the selected|this selection)(?:\s+\d+)?\s/i, () => undefined)) f.ids = (v.selection ?? []).slice(0, 500);
  // Idle / inactivity
  const idle =
    /\s(?:that\s+(?:have\s+been|are)\s+)?(?:idle|inactive|stale|untouched|quiet|dormant|not\s+touched|with\s+no\s+activity|without\s+(?:any\s+)?activity|no\s+activity|no\s+touch(?:es)?)(?:\s+(?:for|in|since|over))?(?:\s+the\s+last)?\s+(?:more\s+than|over|longer\s+than|at\s+least|>\s*|>=\s*)?\s*(\d+)\s*\+?\s*(d|days?|wks?|weeks?|w|mo|months?|m)\b/i;
  if (!take(idle, (m) => (f.idleDays = Number(m[1]) * (UNIT_DAYS[m[2]!.toLowerCase()] ?? 1)))) {
    take(/\s(?:more\s+than\s+|over\s+)?(\d+)\s*\+?\s*(days?|weeks?|months?)\s+(?:idle|inactive|stale|without\s+(?:any\s+)?activity|untouched|quiet)\b/i, (m) => (f.idleDays = Number(m[1]) * (UNIT_DAYS[m[2]!.toLowerCase()] ?? 1)));
  }
  // Hygiene
  take(/\s(?:with\s+|that\s+have\s+)?(?:an?\s+)?overdue(?:\s+next\s+steps?)?\b/i, () => (f.overdue = true));
  take(/\s(?:without|with\s+no|no|missing|lacking)\s+(?:an?\s+)?next[\s-]?steps?\b/i, () => (f.noNextStep = true));
  take(/\s(?:without|with\s+no|no|missing|lacking)\s+(?:an?\s+)?(?:expected\s+)?close\s+dates?\b/i, () => (f.noCloseDate = true));
  take(/\s(?:with\s+)?health(?:\s+score)?\s*(?:below|under|<|less\s+than|lower\s+than)\s*(\d+)\b/i, (m) => (f.healthBelow = Math.min(100, Number(m[1]))));
  take(/\s(?:unhealthy|at[\s-]risk)\b/i, () => (f.healthBelow ??= 40));
  // Priority
  if (!take(/\stop[\s-]?10\b/i, () => (f.priority = "top10"))) take(/\s(high|medium|low)[\s-]priority\b/i, (m) => (f.priority = m[1]!.toLowerCase() as DealFilter["priority"]));
  // Tag
  take(/\stagged\s+(?:as\s+|with\s+)?"?([\w-]+)"?/i, (m) => (f.tag = m[1]!.toLowerCase()));
  // Status
  take(/\s(?:closed[\s-])?won\b/i, () => (f.status = "won"));
  take(/\s(?:closed[\s-])?lost\b/i, () => (f.status = "lost"));
  take(/\s(?:on\s+)?hold\b/i, () => (f.status = "hold"));
  take(/\s(?:all\s+statuses|any\s+status)\b/i, () => (f.status = "any"));
  // Owner
  take(/\s(?:my\s+team'?s?|our\s+team'?s?|team)\b/i, () => (f.team = true));
  take(/\s(?:unassigned|without\s+(?:an?\s+)?owner|no\s+owner|ownerless)\b/i, () => (f.owner = "none"));
  const byUser = (raw: string) => {
    const u = matchUser(raw, v);
    if (u) f.owner = u === v.meId ? "me" : u;
    return Boolean(u);
  };
  take(/\s(?:owned\s+by|belonging\s+to|assigned\s+to|for)\s+(me|myself)\b/i, () => (f.owner = "me"));
  for (const u of [...v.users].sort((a, b) => b.name.length - a.name.length)) {
    const first = u.name.split(/\s+/)[0]!;
    for (const n of [u.name, first]) {
      if (n.length < 2) continue;
      const re = new RegExp(`\\s(?:owned\\s+by|belonging\\s+to|assigned\\s+to|from)\\s+${esc(n)}\\b|\\s${esc(n)}['’]s\\b`, "i");
      if (s.match(re) && byUser(n)) {
        s = s.replace(re, " ");
        break;
      }
    }
    if (f.owner && f.owner !== "none") break;
  }
  take(/\s(?:my|mine|i\s+own)\b/i, () => (f.owner ??= "me"));
  // Stages (vocab-driven, longest names first)
  const stageNames = Array.from(new Set(v.stages.map((st) => st.name))).sort((a, b) => b.length - a.length);
  for (const name of stageNames) {
    const re = new RegExp(`\\s(?:in|at|from|still\\s+in|stuck\\s+in|sitting\\s+in)\\s+(?:the\\s+)?${esc(name)}(?:\\s+stage)?\\b`, "i");
    if (s.match(re)) {
      (f.stageNames ??= []).push(name);
      s = s.replace(re, " ");
    }
  }
  // Pipelines
  const keys: string[] = [];
  for (const p of v.pipelines) {
    const names = [p.name, ...(PIPELINE_ALIASES[p.key] ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
    let hit = false;
    for (const n of names) {
      const re = new RegExp(`\\s${esc(n)}(?=\\s|$)`, "i");
      if (s.match(re)) {
        s = s.replace(re, " ");
        hit = true;
        break;
      }
    }
    // Keys: NET/ENT/SPT/R100 in any case; PAY/ADS only in CAPS or right before "deals"/"pipeline" (common words).
    const keyRe = AMBIGUOUS_KEYS.has(p.key)
      ? new RegExp(`\\s${esc(p.key)}(?=\\s|$)|\\s${esc(p.key.toLowerCase())}(?=\\s+(?:deals?|pipeline))`, "")
      : new RegExp(`\\s${esc(p.key)}(?=\\s|$)`, "i");
    const keyMatch = s.match(keyRe);
    if (keyMatch) {
      s = s.replace(keyMatch[0], " ");
      hit = true;
    }
    if (hit) keys.push(p.key);
  }
  if (keys.length) f.pipelineKeys = keys;

  const leftovers = s
    .split(/\s+/)
    .map((w) => w.replace(/[^\w'-]/g, "").toLowerCase())
    .filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));
  return { filter: f, leftovers };
}

/** Best user match for a name fragment: exact full name → unique first name → unique prefix. Returns the id. */
export function matchUser(raw: string, v: Pick<Vocab, "users" | "meId">): string | null {
  const q = raw.trim().toLowerCase().replace(/^@/, "");
  if (!q) return null;
  if (q === "me" || q === "myself") return v.meId;
  const exact = v.users.filter((u) => u.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!.id;
  const first = v.users.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === q);
  if (first.length === 1) return first[0]!.id;
  const prefix = v.users.filter((u) => u.name.toLowerCase().startsWith(q));
  if (prefix.length === 1 && q.length >= 3) return prefix[0]!.id;
  return null;
}

/** Candidate users for an ambiguous name (for a "did you mean" message). */
export function userCandidates(raw: string, v: Pick<Vocab, "users">): { id: string; name: string }[] {
  const q = raw.trim().toLowerCase();
  return v.users.filter((u) => u.name.toLowerCase().includes(q)).slice(0, 5);
}

/**
 * Stage to move to, per pipeline: exact name/key → name prefix → category keyword ("won", "lost", "hold").
 * Pipelines without a match are absent (their deals are skipped with a reason).
 */
export function resolveStageTarget(raw: string, pipelineKeys: string[], stages: Vocab["stages"]): Map<string, Vocab["stages"][number]> {
  const q = raw
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+stage$/, "");
  const cat = /^(closed[\s-])?won$/.test(q) ? "won" : /^(closed[\s-])?lost$/.test(q) ? "lost" : /^(on\s+)?hold$/.test(q) ? "hold" : null;
  const out = new Map<string, Vocab["stages"][number]>();
  for (const key of pipelineKeys) {
    const list = stages.filter((st) => st.pipelineKey === key);
    const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const qWords = words(q);
    const hit =
      list.find((st) => st.name.toLowerCase() === q || st.key.toLowerCase() === q || words(st.name).join(" ") === qWords.join(" ")) ??
      (q.length >= 3 ? list.filter((st) => st.name.toLowerCase().startsWith(q)).sort((a, b) => a.name.length - b.name.length)[0] : undefined) ??
      // every word of the target appears in the stage name ("nurture" → "Cold / Nurture")
      (qWords.length && q.length >= 3 ? list.filter((st) => qWords.every((w) => words(st.name).some((x) => x.startsWith(w)))).sort((a, b) => a.name.length - b.name.length)[0] : undefined) ??
      (cat ? list.find((st) => st.category === cat) : undefined);
    if (hit) out.set(key, hit);
  }
  return out;
}

/** Full deterministic parse. `command` is null when the sentence doesn't start with a supported verb. */
export function parseCommand(text: string, v: Vocab): ParseOutcome {
  const t = norm(text);
  const sv = splitVerb(t);
  if (!sv) return { command: null, leftovers: t ? t.toLowerCase().split(" ") : [], engine: "rules" };
  const { filter, leftovers } = parseSubject(sv.subject, v);
  let command: Command;
  switch (sv.verb) {
    case "move":
      command = { verb: "move", filter, toStage: sv.target!.replace(/^["']|["']$/g, "") };
      break;
    case "assign":
      command = { verb: "assign", filter, toUser: sv.target!.replace(/^@/, "") };
      break;
    case "tag":
      command = { verb: "tag", filter, tag: normalizeTag(sv.target!) };
      break;
    case "close":
      command = { verb: "close", filter, date: sv.target!.trim() };
      break;
    case "enroll":
      command = { verb: "enroll", filter, sequence: sv.target! };
      break;
    default:
      command = { verb: "show", filter };
  }
  return { command, leftovers, engine: "rules" };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);

/**
 * A close-date phrase → YYYY-MM-DD (calendar date in the user's zone; `today` is that date). Supports ISO dates,
 * "end of (this|next) quarter|month|year", "next quarter", "Dec 15" / "15 Dec" (next occurrence). Null = not understood.
 */
export function resolveCloseDate(raw: string, today: string): string | null {
  const q = raw.trim().toLowerCase().replace(/^(?:the\s+)?/, "");
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  const iso = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = ymd(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return d === q ? d : null;
  }
  const qEnd = (yy: number, qq: number) => ymd(yy, qq * 3 + 3, 0); // day 0 of the month after the quarter
  const curQ = Math.floor(m0 / 3);
  if (/^(?:end\s+of\s+)?(?:this\s+)?(?:quarter|q)$|^eoq$|^end\s+of\s+(?:this\s+)?quarter$/.test(q)) return qEnd(y, curQ);
  if (/^(?:end\s+of\s+)?next\s+quarter$/.test(q)) return curQ === 3 ? qEnd(y + 1, 0) : qEnd(y, curQ + 1);
  if (/^end\s+of\s+(?:this\s+)?month$|^eom$/.test(q)) return ymd(y, m0 + 1, 0);
  if (/^end\s+of\s+next\s+month$/.test(q)) return ymd(y, m0 + 2, 0);
  if (/^end\s+of\s+(?:this\s+|the\s+)?year$|^eoy$/.test(q)) return ymd(y, 12, 0);
  const qn = q.match(/^(?:end\s+of\s+)?q([1-4])(?:\s+(\d{4}))?$/);
  if (qn) {
    const target = Number(qn[1]) - 1;
    const yy = qn[2] ? Number(qn[2]) : target < curQ ? y + 1 : y;
    return qEnd(yy, target);
  }
  const md = q.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/) ?? q.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?$/);
  if (md) {
    const monthTok = /^\d/.test(md[1]!) ? md[2]! : md[1]!;
    const dayTok = /^\d/.test(md[1]!) ? md[1]! : md[2]!;
    const mi = MONTHS.indexOf(monthTok.slice(0, 3));
    const day = Number(dayTok);
    if (mi < 0 || day < 1 || day > 31) return null;
    let yy = md[3] ? Number(md[3]) : y;
    let d = ymd(yy, mi, day);
    if (Number(d.slice(8, 10)) !== day) return null;
    if (!md[3] && d < today) d = ymd((yy = y + 1), mi, day);
    return d;
  }
  return null;
}

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^["'#]+|["']+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .slice(0, 40);
}

/* ───────────── Palette ranking ───────────── */

export type PaletteEntry = { id: string; label: string; keywords?: string[]; group: string; boost?: number };

/**
 * Smart ranking for palette entries: prefix of label > word-start match > subsequence; recent/frequent boost.
 * Returns entries with score > 0 sorted by score (stable for ties).
 */
export function rankEntries<T extends PaletteEntry>(query: string, entries: T[], recent: Record<string, number> = {}): T[] {
  const q = query.trim().toLowerCase();
  const scored = entries.map((e, i) => {
    const label = e.label.toLowerCase();
    const hay = [label, ...(e.keywords ?? []).map((k) => k.toLowerCase())];
    let score = 0;
    if (!q) score = 1;
    else {
      for (const h of hay) {
        if (h === q) score = Math.max(score, 100);
        else if (h.startsWith(q)) score = Math.max(score, 80);
        else if (h.split(/[\s/·-]+/).some((w) => w.startsWith(q))) score = Math.max(score, 60);
        else if (h.includes(q)) score = Math.max(score, 40);
        else if (isSubsequence(q, h)) score = Math.max(score, 15);
      }
    }
    if (score > 0) score += (e.boost ?? 0) + Math.min(20, (recent[e.id] ?? 0) * 4);
    return { e, score, i };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.e);
}

function isSubsequence(q: string, h: string): boolean {
  let j = 0;
  for (let i = 0; i < h.length && j < q.length; i++) if (h[i] === q[j]) j++;
  return j === q.length;
}

/** Does this text look like a command (vs. a search query)? Used to decide whether to offer "Run command". */
export function looksLikeCommand(text: string): boolean {
  return /^(?:re-?assign|assign|give|hand|transfer|move|shift|push|mark|set|put|change|update|tag|label|add|apply|enrol|enroll|show|find|list|select|filter)\s+\S+/i.test(text.trim());
}

/**
 * QA MAJ-20: a verb-prefixed query ("add note …", "find …") must still show the matching palette actions. True when an
 * action label/keyword starts with the query (or the query starts with a whole label/keyword) — then the Actions group
 * leads and "Preview as command" is offered after it; otherwise the command preview leads.
 */
export function actionsLeadForQuery(query: string, entries: PaletteEntry[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = q.split(/\s+/);
  const lead = words.length >= 2 ? words.slice(0, 2).join(" ") : null; // "add note to Acme" → "add note"
  return entries.some((e) =>
    [e.label, ...(e.keywords ?? [])].some((h) => {
      const t = h.toLowerCase();
      // A bare verb keyword ("move", "assign") is what commands start with — only multi-word phrases count.
      const phrase = t.includes(" ");
      return t.startsWith(q) || q === t || (phrase && q.startsWith(`${t} `)) || (lead != null && t.startsWith(lead));
    }),
  );
}
