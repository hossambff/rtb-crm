/**
 * Copilot guardrails — pure helpers (unit-tested). Server code composes these with RBAC queries.
 * PRD §7.1 field security, §11.4 autonomy, §11.5 claims/MNPI/prompt-injection.
 */
import { isFieldHidden, SCOPE_RANK, type Role, type Scope } from "@/lib/rbac/model";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function clip(text: string | null | undefined, max = 600): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Remove fields the role may not see by the CODE DEFAULTS only (pure, unit-tested). Server code with DB access should
 * strip with getHiddenFields(role, entity) from @/lib/rbac/server, which also applies admin field_permissions.
 */
export function stripHiddenFields<T extends Record<string, unknown>>(role: Role, entity: string, obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isFieldHidden(role, entity, k)) out[k] = v;
  }
  return out as Partial<T>;
}

/** Drop restricted records unless the user is on their access list (ids in `allowed`) or is super_admin. */
export function excludeRestricted<T extends { id: string; restricted?: boolean | null }>(role: Role, rows: T[], allowed: Set<string>): T[] {
  if (role === "super_admin") return rows;
  return rows.filter((r) => !r.restricted || allowed.has(r.id));
}

/** May the acting user assign a task to `assigneeId` given their tasks.assign scope? */
export function canAssignTo(user: { id: string; teamMemberIds: string[] }, assignScope: Scope, assigneeId: string): boolean {
  if (assigneeId === user.id) return true;
  if (SCOPE_RANK[assignScope] >= SCOPE_RANK.pipeline) return true;
  if (assignScope === "team") return user.teamMemberIds.includes(assigneeId);
  return false;
}

export type AutonomyDecision = "refuse" | "suggest" | "auto";

/**
 * PRD §11.4: level 0 off, 1 suggest, ≥2 auto (+notify). §11.5: when the run has processed untrusted external content
 * (emails, transcripts, web pages), write tools are capped at Level 1 (suggest).
 */
export function autonomyDecision(level: number | null | undefined, untrustedSeen: boolean): AutonomyDecision {
  const l = typeof level === "number" && Number.isFinite(level) ? level : 1;
  if (l <= 0) return "refuse";
  if (l === 1 || untrustedSeen) return "suggest";
  return "auto";
}

/** Map stage required-field keys to a readable label + presence check. */
const FIELD_LABELS: Record<string, string> = {
  muu: "MUU",
  revSharePct: "Revenue share %",
  primaryContactId: "Primary contact",
  contractValueCents: "Contract value",
  annualizedValueCents: "Annualized value",
  expectedCloseDate: "Expected close date",
  guaranteeType: "Guarantee type",
  termYears: "Term (years)",
};

export function gateIssues(
  stage: { requiredFields: string[]; requiresApproval: boolean; category: string; name: string },
  deal: Record<string, unknown> & { customFields?: Record<string, unknown> | null },
): string[] {
  const issues: string[] = [];
  for (const f of stage.requiredFields) {
    const v = f in deal ? deal[f] : deal.customFields?.[f];
    if (v === null || v === undefined || v === "") issues.push(`${FIELD_LABELS[f] ?? f} is required to enter "${stage.name}"`);
  }
  if (stage.requiresApproval) issues.push(`"${stage.name}" requires approval — applying will submit an approval request`);
  if (stage.category === "won" || stage.category === "lost") issues.push(`This marks the deal as ${stage.category.toUpperCase()} — only a person can confirm this`);
  return issues;
}

/**
 * MNPI scan for drafts to external parties (PRD §11.5): warn about internal financial figures, pipeline totals,
 * forecasts and other clients' deal terms.
 */
const MNPI_PATTERNS: { re: RegExp; warning: string }[] = [
  { re: /\b(pipeline|weighted|forecast(ed)?|bookings|quota)\b[^.\n]{0,40}\$?\d/i, warning: "Mentions internal pipeline/forecast figures" },
  { re: /\$?\d+(\.\d+)?\s?(m|mm|million|b|bn|billion)\b[^.\n]{0,30}\b(pipeline|forecast|arr|run[- ]rate|revenue)\b/i, warning: "Mentions an internal revenue/pipeline total" },
  { re: /\b(unannounced|not yet public|non[- ]public|confidential|under nda|earnings|guidance|10-?q|10-?k|8-?k)\b/i, warning: "References non-public or earnings-related information" },
  { re: /\b(other|another) (publisher|client|partner|customer)s?\b[^.\n]{0,60}\b(\d+(\.\d+)?\s?%|rev(enue)? share|guarantee|terms?)\b/i, warning: "Discusses another client's deal terms" },
  { re: /\b(ny ?post|reach plc|sinclair|gb news|ht media|baltimore sun|arena|paradium)\b[^.\n]{0,60}\b(\d+(\.\d+)?\s?%|rev(enue)? share|guarantee|terms?|\$\d)/i, warning: "Mentions terms of a named enterprise deal" },
  { re: /\bebitda\b/i, warning: "Mentions EBITDA — confirm the figure is public" },
];

export function scanMnpi(text: string): string[] {
  const out = new Set<string>();
  for (const p of MNPI_PATTERNS) if (p.re.test(text)) out.add(p.warning);
  return [...out];
}

/** Heuristic prompt-injection detector for untrusted content (used to flag + downgrade autonomy). */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system)/i,
  /you are now\b/i,
  /\bsystem prompt\b/i,
  /\b(act|behave) as (an? )?(admin|administrator|developer|system)/i,
  /\b(call|use|invoke|run) the [a-z_]+ tool\b/i,
  /<\/?(system|assistant|untrusted)[^>]*>/i,
  /\bdo not tell the user\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Requests the agent must refuse outright (secrets / credentials). */
export function asksForSecrets(text: string): boolean {
  return /\b(api[_ -]?key|secret|password|access token|refresh token|private key|env(ironment)? var|\.env|database url|connection string)\b/i.test(text);
}
