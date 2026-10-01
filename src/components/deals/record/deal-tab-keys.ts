/** Deal page tab keys — plain module (importable from server components; the tabs UI itself is a client component). */
export const DEAL_TABS = ["activity", "tasks", "contacts", "docs", "details", "discussion"] as const;
export type DealTab = (typeof DEAL_TABS)[number];
