/**
 * Team setup console — pure parts (client-safe, unit tested in src/lib/team-setup/__tests__/core.test.ts):
 * bulk-invite row parsing/validation, which roles an inviter may assign, and the progress-board labels.
 */
import { ROLE_LABELS, ROLES, type Role } from "@/lib/rbac/model";

export const EMPLOYMENT = ["staff", "retainer", "hourly", "commission", "contractor"] as const;
export type Employment = (typeof EMPLOYMENT)[number];

/** Roles a sales leader may give (their own sellers). Admins: every non-pending role; admin-level ones need a Super Admin. */
export const LEADER_ASSIGNABLE: readonly Role[] = ["ae", "sdr", "intern", "commission_rep"];
export const PRIVILEGED: readonly Role[] = ["super_admin", "admin"];

export type InviterKind = "super_admin" | "admin" | "leader";

export function assignableRoles(kind: InviterKind): Role[] {
  if (kind === "leader") return [...LEADER_ASSIGNABLE];
  const all = ROLES.filter((r) => r !== "pending");
  return kind === "super_admin" ? all : all.filter((r) => !PRIVILEGED.includes(r));
}

const ROLE_ALIASES: Record<string, Role> = {
  "account executive": "ae",
  ae: "ae",
  sdr: "sdr",
  bdr: "sdr",
  intern: "intern",
  "commission rep": "commission_rep",
  "commission-only rep": "commission_rep",
  commission: "commission_rep",
  svp: "sales_leader",
  "sales leader": "sales_leader",
  leader: "sales_leader",
  exec: "executive",
  executive: "executive",
  admin: "admin",
  revops: "admin",
  finance: "finance",
  editorial: "editorial",
  viewer: "viewer",
  onboarding: "onboarding",
};

/** "AE", "Account Executive", "account_executive", "sdr" … → role key (null when unknown). */
export function parseRole(raw: string): Role | null {
  const v = raw.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  if (!v) return null;
  if ((ROLES as readonly string[]).includes(v.replace(/ /g, "_"))) return v.replace(/ /g, "_") as Role;
  if (ROLE_ALIASES[v]) return ROLE_ALIASES[v]!;
  const byLabel = (Object.entries(ROLE_LABELS) as [Role, string][]).find(([, l]) => l.toLowerCase() === v || l.toLowerCase().split(" / ").includes(v));
  return byLabel ? byLabel[0] : null;
}

export function parseEmployment(raw: string): Employment | null {
  const v = raw.trim().toLowerCase();
  if (!v) return "staff";
  if ((EMPLOYMENT as readonly string[]).includes(v)) return v as Employment;
  if (v.startsWith("commission")) return "commission";
  if (v === "full-time" || v === "full time" || v === "employee" || v === "ft") return "staff";
  if (v === "contract" || v === "freelance") return "contractor";
  return null;
}

export type Lookup = { id: string; name: string; email?: string | null };

export type InviteContext = {
  teams: Lookup[];
  /** Active people who can be managers. */
  people: Lookup[];
  allowed: readonly Role[];
  /** Emails that already have an account (lower-case). */
  existingEmails: ReadonlySet<string>;
  /** Allowed sign-in domains (lower-case); empty = any. */
  domains: readonly string[];
  /** When set (sales leaders), every row goes to this team regardless of the team column. */
  forcedTeamId?: string | null;
  defaultManagerId?: string | null;
};

export type InviteRow = {
  line: number;
  email: string;
  name: string;
  role: Role | null;
  teamId: string | null;
  managerId: string | null;
  employmentType: Employment;
  errors: string[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitLine(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ",";
  return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
}

function findBy(list: Lookup[], raw: string): Lookup | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return list.find((x) => x.id === raw.trim() || x.email?.toLowerCase() === v || x.name.toLowerCase() === v) ?? null;
}

/**
 * Parse pasted rows "email, name, role, team, manager, employment type" (comma, tab or semicolon separated; a header
 * row and blank lines are ignored). Each row is validated against the inviter's context; problems are listed per row
 * so the person can fix them before anything is created. Duplicate emails within the paste are flagged.
 */
export function parseInviteRows(text: string, ctx: InviteContext, maxRows = 100): { rows: InviteRow[]; tooMany: boolean } {
  const lines = text.split(/\r?\n/);
  const rows: InviteRow[] = [];
  const seen = new Set<string>();
  let tooMany = false;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = splitLine(raw);
    if (i === 0 && /^e-?mail$/i.test(cells[0] ?? "")) return; // header
    if (rows.length >= maxRows) {
      tooMany = true;
      return;
    }
    const [emailRaw = "", nameRaw = "", roleRaw = "", teamRaw = "", managerRaw = "", empRaw = ""] = cells;
    rows.push(validateInvite({ line: i + 1, email: emailRaw, name: nameRaw, role: roleRaw, team: teamRaw, manager: managerRaw, employment: empRaw }, ctx, seen));
  });
  return { rows, tooMany };
}

export function validateInvite(
  r: { line: number; email: string; name: string; role: string; team: string; manager: string; employment: string },
  ctx: InviteContext,
  seen: Set<string> = new Set(),
): InviteRow {
  const errors: string[] = [];
  const email = r.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) errors.push("Email looks wrong");
  else {
    const domain = email.split("@")[1]!;
    if (ctx.domains.length && !ctx.domains.includes(domain)) errors.push(`${domain} isn't an allowed sign-in domain`);
    if (ctx.existingEmails.has(email)) errors.push("Already has an account");
    if (seen.has(email)) errors.push("Listed twice");
    seen.add(email);
  }
  const name = r.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) errors.push("Add a name");
  const role = parseRole(r.role);
  if (!role) errors.push(r.role.trim() ? `Unknown role “${r.role.trim()}”` : "Add a role");
  else if (!ctx.allowed.includes(role)) errors.push(`You can't assign ${ROLE_LABELS[role]}`);
  let teamId: string | null = ctx.forcedTeamId ?? null;
  if (ctx.forcedTeamId === undefined && r.team.trim()) {
    const t = findBy(ctx.teams, r.team);
    if (!t) errors.push(`Unknown team “${r.team.trim()}”`);
    teamId = t?.id ?? null;
  }
  let managerId: string | null = ctx.defaultManagerId ?? null;
  if (r.manager.trim()) {
    const m = findBy(ctx.people, r.manager);
    if (!m) errors.push(`Unknown manager “${r.manager.trim()}”`);
    managerId = m?.id ?? managerId;
  }
  const employmentType = parseEmployment(r.employment);
  if (!employmentType) errors.push(`Unknown employment type “${r.employment.trim()}”`);
  return { line: r.line, email, name, role, teamId, managerId, employmentType: employmentType ?? "staff", errors };
}

export const STATUS_LABELS = { not_started: "Not started", in_progress: "In progress", done: "Done", deferred: "Deferred" } as const;
