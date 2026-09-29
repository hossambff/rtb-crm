import type { Action, Matrix, Module, Role, Scope } from "./model";
import { MODULES } from "./model";

type Grant = Partial<Record<Action, Scope>>;
const all = (actions: Action[]): Grant => Object.fromEntries(actions.map((a) => [a, "all"])) as Grant;
const g = (m: Record<string, Scope>): Grant => m as Grant;

const CRUD: Action[] = ["view", "create", "edit", "delete", "assign", "export"];
const everything = (): Matrix => {
  const m: Matrix = {};
  for (const mod of MODULES) m[mod] = all(["view", "create", "edit", "delete", "assign", "export", "import", "approve", "configure", "use_ai"]);
  return m;
};

const dealsFor = (scopes: Partial<Record<string, Grant>>): Matrix => {
  const m: Matrix = {};
  for (const key of ["NET", "ENT", "SPT", "R100", "ADS", "PAY"]) {
    const grant = scopes[key] ?? scopes["*"];
    if (grant) m[`deals_${key}` as Module] = grant;
  }
  return m;
};

/** Default permission matrix per role — PRD Appendix B. Admins override cells in rso.role_permissions. */
export const DEFAULT_MATRIX: Record<Role, Matrix> = {
  super_admin: everything(),
  admin: { ...everything(), audit: all(["view"]) },
  executive: {
    ...dealsFor({ "*": all(["view", "create", "edit", "assign", "export", "approve"]) }),
    accounts: all(["view", "create", "edit", "assign", "export"]),
    contacts: all(["view", "create", "edit", "export"]),
    activities: all(["view", "create", "edit"]),
    tasks: all(["view", "create", "edit", "assign"]),
    email: g({ view: "all" }),
    calls: g({ view: "all", create: "all" }),
    copilot: g({ use_ai: "all" }),
    proposals: all(["view", "create", "edit", "approve"]),
    onboarding: g({ view: "all" }),
    revenue: g({ view: "all" }),
    commissions: g({ view: "all", approve: "all" }),
    analytics: g({ view: "all", export: "all" }),
    scout: g({ view: "all", create: "all", edit: "all", assign: "all" }),
    enrichment: g({ create: "all", view: "all" }),
    export: g({ export: "all" }),
    audit: g({ view: "all" }),
  },
  sales_leader: {
    ...dealsFor({
      "*": g({ view: "all", create: "all", edit: "all", assign: "all", export: "team", approve: "team" }),
      ENT: g({ view: "pipeline", create: "pipeline", edit: "pipeline", assign: "pipeline", export: "team" }),
    }),
    accounts: g({ view: "all", create: "all", edit: "all", assign: "all", export: "team" }),
    contacts: g({ view: "all", create: "all", edit: "all", export: "team" }),
    activities: g({ view: "team", create: "all", edit: "own" }),
    tasks: g({ view: "team", create: "all", edit: "team", assign: "team" }),
    email: g({ view: "team" }),
    calls: g({ view: "team", create: "all" }),
    copilot: g({ use_ai: "all" }),
    proposals: g({ view: "all", create: "all", edit: "all", approve: "team" }),
    onboarding: g({ view: "all" }),
    revenue: g({ view: "all" }),
    commissions: g({ view: "team" }),
    analytics: g({ view: "team", export: "team" }),
    scout: g({ view: "all", create: "all", edit: "all", assign: "all" }),
    enrichment: g({ create: "all", view: "all" }),
    import: g({ import: "team" }),
    export: g({ export: "team" }),
  },
  ae: {
    ...dealsFor({ "*": g({ view: "all", create: "team", edit: "team" }), ENT: g({ view: "own", edit: "own" }) }),
    accounts: g({ view: "all", create: "own", edit: "own" }),
    contacts: g({ view: "all", create: "own", edit: "own" }),
    activities: g({ view: "team", create: "own", edit: "own" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    proposals: g({ view: "own", create: "own", edit: "own" }),
    onboarding: g({ view: "all" }),
    revenue: g({ view: "team" }),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
    scout: g({ view: "all", create: "own", edit: "own" }),
    enrichment: g({ create: "own", view: "own" }),
    export: g({ export: "own" }),
  },
  sdr: {
    ...dealsFor({ "*": g({ view: "all", create: "own", edit: "own" }), ENT: g({}), PAY: g({}) }),
    accounts: g({ view: "all", create: "own", edit: "own" }),
    contacts: g({ view: "all", create: "own", edit: "own" }),
    activities: g({ view: "own", create: "own", edit: "own" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
    scout: g({ view: "all", create: "own", edit: "own" }),
    enrichment: g({ create: "own", view: "own" }),
  },
  intern: {
    ...dealsFor({ "*": g({ view: "own", create: "own", edit: "own" }), ENT: g({}), PAY: g({}), ADS: g({ view: "own" }) }),
    accounts: g({ view: "all", create: "own", edit: "own" }),
    contacts: g({ view: "own", create: "own", edit: "own" }),
    activities: g({ view: "own", create: "own", edit: "own" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
    scout: g({ view: "own", create: "own" }),
    enrichment: g({ create: "own", view: "own" }),
  },
  commission_rep: {
    ...dealsFor({ "*": g({ view: "own", create: "own", edit: "own" }), ENT: g({}), PAY: g({}) }),
    accounts: g({ view: "own", create: "own", edit: "own" }),
    contacts: g({ view: "own", create: "own", edit: "own" }),
    activities: g({ view: "own", create: "own", edit: "own" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    revenue: g({ view: "own" }),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
    scout: g({ view: "own", create: "own" }),
    enrichment: g({ create: "own", view: "own" }),
  },
  onboarding: {
    ...dealsFor({ "*": g({ view: "all" }) }),
    accounts: g({ view: "all" }),
    contacts: g({ view: "all" }),
    activities: g({ view: "all", create: "own" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    onboarding: all(["view", "create", "edit", "assign"]),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
  },
  finance: {
    ...dealsFor({ "*": g({ view: "all" }), ADS: g({ view: "all", edit: "all" }) }),
    accounts: g({ view: "all" }),
    contacts: g({ view: "all" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    copilot: g({ use_ai: "own" }),
    proposals: g({ view: "all" }),
    revenue: all(["view", "create", "edit", "delete"]),
    commissions: all(["view", "create", "edit", "approve", "configure"]),
    analytics: g({ view: "all", export: "all" }),
    export: g({ export: "all" }),
    audit: g({ view: "all" }),
  },
  editorial: {
    deals_R100: all(["view", "create", "edit"]),
    accounts: g({ view: "all" }),
    contacts: g({ view: "all" }),
    tasks: g({ view: "own", create: "own", edit: "own" }),
    email: g({ view: "own" }),
    calls: g({ view: "own", create: "own" }),
    copilot: g({ use_ai: "own" }),
    commissions: g({ view: "own" }),
    analytics: g({ view: "own" }),
    enrichment: g({ create: "own", view: "own" }),
  },
  viewer: {
    ...dealsFor({ "*": g({ view: "all" }), ENT: g({}) }),
    accounts: g({ view: "all" }),
    onboarding: g({ view: "all" }),
    revenue: g({ view: "all" }),
    analytics: g({ view: "all" }),
  },
  pending: {},
};

export { CRUD };
