import { requireUser } from "@/lib/rbac/server";
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/auth";
import { loadWizard } from "@/lib/welcome/queries";
import { parseStep } from "@/lib/welcome/core";
import { WelcomeWizard } from "@/components/welcome/wizard";

export const metadata = { title: "Welcome" };

export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const user = await requireUser();
  const sp = await searchParams;
  const data = await loadWizard(user);
  const asked = parseStep(typeof sp.step === "string" ? sp.step : null, data.steps);
  return <WelcomeWizard data={data} initialStep={asked ?? data.progress.next} scopes={GOOGLE_WORKSPACE_SCOPES} />;
}
