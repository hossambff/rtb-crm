/**
 * Permission model (PRD §7): Module × Action × Scope.
 * Pure data + helpers, safe to import from client components (no server-only deps).
 */
export const MODULES = [
  "accounts",
  "contacts",
  "deals_NET",
  "deals_ENT",
  "deals_SPT",
  "deals_R100",
  "deals_ADS",
  "deals_PAY",
  "activities",
  "tasks",
  "email",
  "calls",
  "copilot",
  "proposals",
  "onboarding",
  "revenue",
  "commissions",
  "analytics",
  "scout",
  "enrichment",
  "import",
  "export",
  "admin",
  "audit",
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ["view", "create", "edit", "delete", "assign", "export", "import", "approve", "configure", "use_ai"] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ["none", "own", "team", "pipeline", "all"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, pipeline: 3, all: 4 };

export const ROLES = [
  "super_admin",
  "admin",
  "executive",
  "sales_leader",
  "ae",
  "sdr",
  "intern",
  "commission_rep",
  "onboarding",
  "finance",
  "editorial",
  "viewer",
  "pending",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin / RevOps",
  executive: "Executive",
  sales_leader: "SVP / Sales Leader",
  ae: "Account Executive",
  sdr: "SDR",
  intern: "Intern",
  commission_rep: "Commission-only Rep",
  onboarding: "Onboarding / Migration",
  finance: "Finance",
  editorial: "Editorial",
  viewer: "Viewer",
  pending: "Pending approval",
};

export const PIPELINE_MODULE: Record<string, Module> = {
  NET: "deals_NET",
  ENT: "deals_ENT",
  SPT: "deals_SPT",
  R100: "deals_R100",
  ADS: "deals_ADS",
  PAY: "deals_PAY",
};

export type Matrix = Partial<Record<Module, Partial<Record<Action, Scope>>>>;

/** Fields hidden from roles by default (PRD §7.1 field-level security). entity.field → roles */
export const DEFAULT_HIDDEN_FIELDS: Record<string, Role[]> = {
  "deal.revSharePct": ["intern", "commission_rep", "viewer", "editorial"],
  "deal.guaranteeMonthlyCents": ["intern", "commission_rep", "viewer", "editorial"],
  "deal.guaranteeType": ["intern", "commission_rep", "viewer", "editorial"],
  "deal.termYears": ["intern", "viewer", "editorial"],
  "proposal.*": ["intern", "commission_rep", "sdr", "viewer", "editorial"],
};

export function isFieldHidden(role: Role, entity: string, field: string): boolean {
  const exact = DEFAULT_HIDDEN_FIELDS[`${entity}.${field}`];
  const wildcard = DEFAULT_HIDDEN_FIELDS[`${entity}.*`];
  return Boolean(exact?.includes(role) || wildcard?.includes(role));
}
