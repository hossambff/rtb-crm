import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, requireUser } from "@/lib/rbac/server";
import { EmptyState } from "@/components/ui/misc";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { CaptureForm } from "@/components/capture/capture-form";

export const metadata = { title: "Capture" };

/** V2 A10: mobile-friendly quick capture (also reachable from the topbar). `?dealId=` preselects a deal. */
export default async function CapturePage({ searchParams }: PageProps<"/capture">) {
  const user = await requireUser();
  if (!(await can(user, "activities", "create"))) {
    return <EmptyState title="Capture isn't available for your role" description="Your role can't log activities. Ask an admin if you need it." />;
  }
  const sp = await searchParams;
  const dealId = typeof sp.dealId === "string" && /^[0-9a-f-]{36}$/i.test(sp.dealId) ? sp.dealId : null;
  const deal = dealId ? await getAccessibleDeal(user, dealId, "view") : null;
  const [pipeline] = deal ? await db.select({ key: s.pipelines.key }).from(s.pipelines).where(eq(s.pipelines.id, deal.pipelineId)) : [];
  return (
    <div className="mx-auto max-w-xl">
      <header className="mb-5">
        <h1 className="font-display text-[28px] font-medium leading-9 text-fg">Capture</h1>
        <p className="mt-1 text-sm text-secondary">Right after a call or meeting: say what happened. You review everything before it’s saved.</p>
      </header>
      <div className="rounded-lg border border-border bg-surface-1 p-4 sm:p-5">
        <CaptureForm initialTarget={deal ? { id: deal.id, name: deal.name, kind: "deal", subtitle: pipeline?.key } : null} />
      </div>
    </div>
  );
}
