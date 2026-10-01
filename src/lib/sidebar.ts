/**
 * Sidebar width preference, shared by the server layout (reads the cookie for the first paint) and the client sidebar
 * (writes it). Lives outside the "use client" sidebar module: server code importing a constant from a client module
 * gets a client reference, not the value.
 */
export type SidebarMode = "auto" | "expanded" | "collapsed";
export const SIDEBAR_COOKIE = "rso_sidebar";

export function parseSidebarMode(v: string | undefined | null): SidebarMode {
  return v === "expanded" || v === "collapsed" ? v : "auto";
}
