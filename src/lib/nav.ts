import type { Action, Module } from "@/lib/rbac/model";

export type NavItem = {
  href: string;
  label: string;
  icon: string; // lucide icon name
  module?: Module;
  action?: Action;
  anyOf?: Module[]; // visible if user can view any of these
  group: "work" | "programs" | "insights" | "system";
};

export const NAV: NavItem[] = [
  { href: "/home", label: "My Day", icon: "Sun", group: "work" },
  { href: "/pipelines", label: "Pipelines", icon: "Columns3", group: "work", anyOf: ["deals_NET", "deals_ENT", "deals_SPT", "deals_R100", "deals_ADS", "deals_PAY"] },
  { href: "/accounts", label: "Accounts", icon: "Building2", module: "accounts", group: "work" },
  { href: "/contacts", label: "Contacts", icon: "Users", module: "contacts", group: "work" },
  { href: "/tasks", label: "Tasks & Alerts", icon: "ListChecks", module: "tasks", group: "work" },
  { href: "/inbox", label: "Inbox", icon: "Mail", module: "email", group: "work" },
  { href: "/calls", label: "Calls", icon: "AudioLines", module: "calls", group: "work" },
  { href: "/scout", label: "Lead Scout", icon: "Radar", module: "scout", group: "work" },
  { href: "/copilot", label: "Copilot", icon: "Sparkles", module: "copilot", action: "use_ai", group: "work" },
  { href: "/r100", label: "Roundtable 100", icon: "Trophy", module: "deals_R100", group: "programs" },
  { href: "/proposals", label: "Proposals", icon: "FileText", module: "proposals", group: "programs" },
  { href: "/onboarding", label: "Onboarding", icon: "Rocket", module: "onboarding", group: "programs" },
  { href: "/revenue", label: "Revenue", icon: "Receipt", module: "revenue", group: "programs" },
  { href: "/commissions", label: "Commissions", icon: "BadgeDollarSign", module: "commissions", group: "programs" },
  { href: "/analytics", label: "Analytics", icon: "ChartNoAxesCombined", module: "analytics", group: "insights" },
  { href: "/import", label: "Import", icon: "Upload", module: "import", action: "import", group: "system" },
  { href: "/admin", label: "Admin", icon: "Settings2", module: "admin", action: "configure", group: "system" },
];

export const NAV_GROUP_LABELS: Record<NavItem["group"], string> = {
  work: "Work",
  programs: "Programs",
  insights: "Insights",
  system: "System",
};
