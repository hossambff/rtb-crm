import { SCOPE_RANK, type Action, type Matrix, type Module, type Scope } from "@/lib/rbac/model";

/**
 * Naming (QA MAJ-02): the page at /home is "My Day" (nav, <title>, "Back to My Day" links); the ranked list on it is
 * "Today" (the queue, "lands in their Today list", the daily "Today:" digest).
 */
export const HOME_PAGE_NAME = "My Day";
export const QUEUE_NAME = "Today";

const DEAL_MODULES: Module[] = ["deals_NET", "deals_ENT", "deals_SPT", "deals_R100", "deals_ADS", "deals_PAY"];

export type NavItem = {
  href: string;
  label: string;
  icon: string; // lucide icon name
  module?: Module;
  action?: Action;
  anyOf?: Module[]; // visible if user can view any of these
  unless?: { module: Module; action: Action }; // hidden when the user holds this permission (avoid duplicate entries)
  /**
   * Extra permissions the item needs to be useful (all must hold; each = any of `modules` with ≥ `min` on `action`).
   * Hidden when missing: e.g. Pipeline review needs team analytics (QA MAJ-22).
   */
  requires?: { modules: Module[]; action: Action; min: Scope }[];
  group: "top" | "sell" | "engage" | "programs" | "insights" | "system";
  /** Small trailing hint (e.g. a keyboard shortcut). */
  hint?: string;
};

/**
 * Sidebar information architecture (Oct 2026 reorg): grouped by intent, no "More" menu — permissions decide what a role
 * sees. Top: the two things everyone uses all day (My Day, Copilot) plus Tasks. Then Sell (records), Engage
 * (conversations), Programs, Insights, and a collapsed System footer.
 */
export const NAV: NavItem[] = [
  { href: "/home", label: HOME_PAGE_NAME, icon: "Sun", group: "top" },
  { href: "/copilot", label: "Copilot", icon: "Sparkles", module: "copilot", action: "use_ai", group: "top", hint: "⌘J" },
  { href: "/tasks", label: "Tasks & Alerts", icon: "ListChecks", module: "tasks", group: "top" },
  { href: "/pipelines", label: "Pipelines", icon: "Columns3", group: "sell", anyOf: DEAL_MODULES },
  { href: "/deals", label: "Deals", icon: "Table2", group: "sell", anyOf: DEAL_MODULES },
  { href: "/accounts", label: "Accounts", icon: "Building2", module: "accounts", group: "sell" },
  { href: "/contacts", label: "Contacts", icon: "Users", module: "contacts", group: "sell" },
  { href: "/scout", label: "Lead Scout", icon: "Radar", module: "scout", group: "sell" },
  // Inbox / Sequences: email work needs a role that logs activity or prospects (finance only reads; QA MAJ-22).
  { href: "/inbox", label: "Inbox", icon: "Mail", module: "email", group: "engage", requires: [{ modules: ["activities", ...DEAL_MODULES], action: "create", min: "own" }] },
  { href: "/calls", label: "Calls", icon: "AudioLines", module: "calls", group: "engage" },
  { href: "/sequences", label: "Sequences", icon: "Workflow", module: "email", group: "engage", requires: [{ modules: ["contacts"], action: "edit", min: "own" }] },
  { href: "/r100", label: "Roundtable 100", icon: "Trophy", module: "deals_R100", group: "programs" },
  { href: "/proposals", label: "Proposals", icon: "FileText", module: "proposals", group: "programs" },
  { href: "/onboarding", label: "Client onboarding", icon: "Rocket", module: "onboarding", group: "programs" },
  { href: "/revenue", label: "Revenue", icon: "Receipt", module: "revenue", group: "programs" },
  { href: "/commissions", label: "Commissions", icon: "BadgeDollarSign", module: "commissions", group: "programs" },
  // Forecast: roles that work a book of deals (team-level deal edit) — not SDRs, interns or commission reps.
  { href: "/forecast", label: "Forecast", icon: "TrendingUp", anyOf: DEAL_MODULES, group: "insights", requires: [{ modules: DEAL_MODULES, action: "edit", min: "team" }] },
  // Pipeline review is a leader ritual: team analytics scope or more.
  { href: "/review", label: "Pipeline review", icon: "ClipboardCheck", module: "analytics", group: "insights", requires: [{ modules: ["analytics"], action: "view", min: "team" }] },
  { href: "/team", label: "Team", icon: "Megaphone", group: "insights" },
  // Team onboarding console for leaders/execs (admins use Admin → Team setup).
  { href: "/team/setup", label: "Team setup", icon: "UserPlus", group: "insights", requires: [{ modules: ["analytics"], action: "view", min: "team" }], unless: { module: "admin", action: "configure" } },
  { href: "/analytics", label: "Analytics", icon: "ChartNoAxesCombined", module: "analytics", group: "insights" },
  { href: "/import", label: "Import", icon: "Upload", module: "import", action: "import", group: "system" },
  { href: "/admin", label: "Admin", icon: "Settings2", module: "admin", action: "configure", group: "system" },
  // executives / finance: audit log without the rest of the admin console (admins reach it inside /admin)
  { href: "/admin/audit", label: "Audit log", icon: "ScrollText", module: "audit", action: "view", unless: { module: "admin", action: "configure" }, group: "system" },
];

export const NAV_GROUPS = ["top", "sell", "engage", "programs", "insights", "system"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  top: "",
  sell: "Sell",
  engage: "Engage",
  programs: "Programs",
  insights: "Insights",
  system: "System",
};

/** Nav items a permission matrix allows (pure; nav-server applies it to the user's role matrix). */
export function filterNav(items: readonly NavItem[], matrix: Matrix): NavItem[] {
  const scope = (m: Module, a: Action): Scope => matrix[m]?.[a] ?? "none";
  const has = (m: NavItem["module"], a: NavItem["action"]) => Boolean(m) && scope(m!, a ?? "view") !== "none";
  return items.filter((item) => {
    if (item.unless && has(item.unless.module, item.unless.action)) return false;
    if (item.requires?.some((r) => !r.modules.some((m) => SCOPE_RANK[scope(m, r.action)] >= SCOPE_RANK[r.min]))) return false;
    if (item.anyOf) return item.anyOf.some((m) => scope(m, "view") !== "none");
    if (!item.module) return true;
    return scope(item.module, item.action ?? "view") !== "none";
  });
}
