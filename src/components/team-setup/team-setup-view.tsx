import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";
import type { AppUser } from "@/lib/rbac/server";
import { allowedDomainList } from "@/lib/admin/provision";
import { isPlaceholderEmail } from "@/lib/admin/claim-plan";
import { assignableRoles } from "@/lib/team-setup/core";
import { loadBoard, loadClaims, loadPlaceholderAssign, loadQuotaGrid } from "@/lib/team-setup/queries";
import type { SetupScope } from "@/lib/team-setup/scope";
import { TeamSetupTabs } from "./console";
import { ProgressBoard } from "./progress-board";
import { InvitePanel } from "./invite-panel";
import { ClaimsQueue } from "./claims-queue";
import { QuotaGrid } from "./quota-grid";

/**
 * Team setup console, shared by /admin/team-setup (admins) and /team/setup (sales leaders: their team; executives:
 * everyone, no invites). Callers resolve `scope` with teamSetupScope() and 403 when it's null.
 */
export async function TeamSetupView({ user, scope }: { user: AppUser; scope: SetupScope }) {
  const [board, claims, quotas, assign, teams, people, domains, myTeam] = await Promise.all([
    loadBoard(user, scope),
    loadClaims(user, scope),
    loadQuotaGrid(user, scope),
    scope.isAdmin && !scope.readOnly ? loadPlaceholderAssign() : Promise.resolve(null),
    scope.invite && scope.invite !== "leader" ? db.select({ id: s.teams.id, name: s.teams.name }).from(s.teams).orderBy(asc(s.teams.name)) : Promise.resolve([]),
    scope.invite
      ? db.select({ id: s.user.id, name: s.user.name, email: s.user.email, banned: s.user.banned }).from(s.user).orderBy(asc(s.user.name))
      : Promise.resolve([]),
    scope.invite ? allowedDomainList() : Promise.resolve([]),
    scope.invite === "leader" && user.teamId ? db.select({ id: s.teams.id, name: s.teams.name }).from(s.teams).where(eq(s.teams.id, user.teamId)) : Promise.resolve([]),
  ]);
  const managers = people
    .filter((p) => !p.banned && !isPlaceholderEmail(p.email))
    .filter((p) => scope.memberIds === null || scope.memberIds.includes(p.id) || p.id === user.id)
    .map((p) => ({ id: p.id, name: p.name, email: p.email }));
  const pendingClaims = claims.filter((c) => c.canDecide).length;

  const tabs = [
    { key: "progress", label: "Progress", panel: <ProgressBoard rows={board} readOnly={scope.readOnly} /> },
    ...(scope.invite
      ? [
          {
            key: "invite",
            label: "Invite",
            panel: (
              <InvitePanel
                allowedRoles={assignableRoles(scope.invite)}
                teams={teams}
                people={managers}
                domains={[...env.allowedDomains, ...domains].map((d) => d.toLowerCase())}
                forcedTeam={scope.invite === "leader" ? (myTeam[0] ?? null) : undefined}
                me={{ id: user.id, name: user.name, email: user.email }}
                readOnly={scope.readOnly}
              />
            ),
          },
        ]
      : []),
    { key: "claims", label: "Placeholder claims", count: pendingClaims || claims.length || undefined, panel: <ClaimsQueue claims={claims} assign={assign} /> },
    { key: "quotas", label: "Quotas", count: quotas.proposed || undefined, panel: <QuotaGrid data={quotas} /> },
  ];

  return (
    <div className="space-y-4">
      {scope.readOnly ? (
        <p className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-xs text-secondary">You are viewing as another user — changes are disabled.</p>
      ) : null}
      <TeamSetupTabs tabs={tabs} />
    </div>
  );
}
