import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { teamSetupScope } from "@/lib/team-setup/scope";
import { PageHeader } from "@/components/ui/misc";
import { TeamSetupView } from "@/components/team-setup/team-setup-view";

export const metadata = { title: "Team setup" };

/** Team setup for sales leaders (their team) and executives (everyone); admins also have it under Admin. */
export default async function TeamSetupPage() {
  const user = await requireUser();
  const scope = await teamSetupScope(user);
  if (!scope) forbidden();
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Team setup"
        description={scope.kind === "team" ? "Get your team organized: invites, setup progress, placeholder claims and quotas." : "Everyone's setup progress, placeholder claims and quotas."}
      />
      <TeamSetupView user={user} scope={scope} />
    </div>
  );
}
