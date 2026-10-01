import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { teamSetupScope } from "@/lib/team-setup/scope";
import { TeamSetupView } from "@/components/team-setup/team-setup-view";

export const metadata = { title: "Team setup · Admin" };

export default async function AdminTeamSetupPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden();
  const scope = await teamSetupScope(user);
  if (!scope) forbidden();
  return (
    <section aria-labelledby="ts-title" className="space-y-2">
      <div>
        <h2 id="ts-title" className="font-display text-xl text-fg">
          Team setup
        </h2>
        <p className="text-sm text-muted">Invite people, see who&apos;s set up, settle placeholder claims and set quotas.</p>
      </div>
      <TeamSetupView user={user} scope={scope} />
    </section>
  );
}
