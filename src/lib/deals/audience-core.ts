/**
 * Who-is-who for coordination features (mentions, handoffs, help requests): build the same team view
 * `getCurrentUser()` builds for the signed-in user — team members = same team + direct reports — for every active
 * user, from two small tables. Pure and unit tested.
 */
import type { Role } from "@/lib/rbac/model";
import { ROLES } from "@/lib/rbac/model";

export type DirectoryUserRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  teamId: string | null;
  managerId: string | null;
  employmentType: string | null;
  timezone: string | null;
  banned: boolean | null;
};

export type DirectoryUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  teamId: string | null;
  managerId: string | null;
  teamPipelineKeys: string[];
  teamMemberIds: string[];
  employmentType: string | null;
  timezone: string;
  impersonatedBy: null;
};

export function buildDirectory(users: DirectoryUserRow[], teams: { id: string; pipelineTypes: string[] }[]): DirectoryUser[] {
  const active = users.filter((u) => !u.banned && u.role !== "pending" && (ROLES as readonly string[]).includes(u.role));
  const teamPipes = new Map(teams.map((t) => [t.id, t.pipelineTypes]));
  const byTeam = new Map<string, string[]>();
  const reports = new Map<string, string[]>();
  for (const u of users) {
    if (u.teamId) (byTeam.get(u.teamId) ?? byTeam.set(u.teamId, []).get(u.teamId)!).push(u.id);
    if (u.managerId) (reports.get(u.managerId) ?? reports.set(u.managerId, []).get(u.managerId)!).push(u.id);
  }
  return active.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    role: u.role as Role,
    teamId: u.teamId,
    managerId: u.managerId,
    teamPipelineKeys: u.teamId ? (teamPipes.get(u.teamId) ?? []) : [],
    teamMemberIds: Array.from(new Set([u.id, ...(u.teamId ? (byTeam.get(u.teamId) ?? []) : []), ...(reports.get(u.id) ?? [])])),
    employmentType: u.employmentType,
    timezone: u.timezone ?? "America/New_York",
    impersonatedBy: null,
  }));
}

/** Leaders who can be asked for help (C6): executives, sales leaders and super admins — plus the requester's manager. */
export function isHelpTarget(u: { id: string; role: string }, requester: { id: string; managerId: string | null }): boolean {
  if (u.id === requester.id) return false;
  return u.role === "executive" || u.role === "sales_leader" || u.role === "super_admin" || u.id === requester.managerId;
}
