import { can, requireUser } from "@/lib/rbac/server";
import { getOnboardingData } from "@/lib/onboarding/queries";
import { fmtNumber } from "@/lib/format";
import { STALL_DAYS } from "@/lib/onboarding/calc";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { OnboardingView } from "@/components/onboarding/onboarding-view";

export const metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const user = await requireUser();
  if (!(await can(user, "onboarding", "view"))) return <EmptyState title="No access" description="Your role can't view the migration board." />;
  const d = await getOnboardingData(user);
  return (
    <div>
      <PageHeader title="Onboarding" description="Post-sale migrations: Discovery → Scoping → Clone built → Content migrated → QA → Launched → Hypercare." />
      <section aria-label="Migration summary" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active migrations" value={fmtNumber(d.stats.active)} />
        <Stat label="Stalled" value={fmtNumber(d.stats.stalled)} hint={`No stage change in more than ${STALL_DAYS} days`} />
        <Stat label="Go-live slipped" value={fmtNumber(d.stats.slipped)} hint="Target date passed, not launched" />
        <Stat label="Launched" value={fmtNumber(d.stats.launched)} />
      </section>
      <OnboardingView projects={d.projects} wonDeals={d.wonDeals} owners={d.owners} perms={d.perms} />
    </div>
  );
}
