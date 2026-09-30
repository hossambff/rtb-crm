/** Pure helpers for the roles & permissions editor (client-safe). */
import { DEFAULT_MATRIX } from "@/lib/rbac/defaults";
import { ACTIONS, DEFAULT_HIDDEN_FIELDS, MODULES, type Action, type Matrix, type Module, type Role, type Scope } from "@/lib/rbac/model";

export const FIELD_ENTITIES = ["deal", "account", "contact", "proposal", "commission"] as const;
export const FIELD_ACCESS = ["hidden", "read_only", "editable"] as const;

export const MODULE_LABELS: Record<Module, string> = {
  accounts: "Accounts",
  contacts: "Contacts",
  deals_NET: "Deals · NetDev",
  deals_ENT: "Deals · Enterprise",
  deals_SPT: "Deals · Sports",
  deals_R100: "Deals · RTB100",
  deals_ADS: "Deals · TheStreet",
  deals_PAY: "Deals · Payments",
  activities: "Activities",
  tasks: "Tasks",
  email: "Email",
  calls: "Calls & transcripts",
  copilot: "Copilot",
  proposals: "Proposals",
  onboarding: "Onboarding",
  revenue: "Revenue",
  commissions: "Commissions",
  analytics: "Analytics",
  scout: "Lead Scout",
  enrichment: "Enrichment",
  import: "Import",
  export: "Export",
  admin: "Admin",
  audit: "Audit log",
};

export const ACTION_LABELS: Record<Action, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  assign: "Assign",
  export: "Export",
  import: "Import",
  approve: "Approve",
  configure: "Configure",
  use_ai: "Use AI",
};

export type MatrixCell = { module: Module; action: Action; scope: Scope; def: Scope; override: boolean };

/** Merge defaults and override rows into a full grid for display. */
export function buildGrid(role: Role, overrides: { module: string; action: string; scope: string }[]): MatrixCell[][] {
  const defaults: Matrix = DEFAULT_MATRIX[role] ?? {};
  return MODULES.map((m) =>
    ACTIONS.map((a) => {
      const def = defaults[m]?.[a] ?? "none";
      const o = overrides.find((r) => r.module === m && r.action === a);
      const scope = (o?.scope as Scope | undefined) ?? def;
      return { module: m, action: a, scope, def, override: Boolean(o) && o!.scope !== def };
    }),
  );
}

/** Default hidden-field rules flattened for the field-security table. */
export function defaultHiddenFields(): { entity: string; field: string; roles: Role[] }[] {
  return Object.entries(DEFAULT_HIDDEN_FIELDS).map(([key, roles]) => {
    const [entity, field] = key.split(".") as [string, string];
    return { entity, field, roles };
  });
}
