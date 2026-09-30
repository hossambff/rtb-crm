import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelines } from "@/db/schema";
import { requireUser } from "@/lib/rbac/server";
import { parseFilters } from "@/lib/analytics/filters";
import { analyticsContext, ownerOptions } from "@/lib/analytics/scope";
import { PageHeader } from "@/components/ui/misc";
import { forbidden } from "next/navigation";
import { AnalyticsShell, type AnalyticsTab } from "@/components/analytics/shell";

export default async function AnalyticsLayout({ children }: LayoutProps<"/analytics">) {
  const user = await requireUser();
  const ctx = await analyticsContext(user, parseFilters({}));
  if (!ctx) forbidden(); // QA-09: real 403
  const [pipes, owners] = await Promise.all([
    db.select({ key: pipelines.key, name: pipelines.name }).from(pipelines).where(eq(pipelines.active, true)).orderBy(asc(pipelines.sortOrder)),
    ownerOptions(ctx),
  ]);
  const tabs: AnalyticsTab[] = [
    { href: "/analytics", label: "Executive overview" },
    { href: "/analytics/health", label: "Pipeline health" },
    { href: "/analytics/reps", label: "Rep scorecard" },
    { href: "/analytics/funnel", label: "SDR / intern funnel" },
    { href: "/analytics/netdev", label: "NetDev & Sports" },
    ...(ctx.scoutAllowed ? [{ href: "/analytics/scout", label: "Lead Scout" }] : []),
    { href: "/analytics/ai", label: "AI & automation" },
    { href: "/analytics/quality", label: "Data quality" },
  ];
  const scopeNote =
    ctx.scope === "all" ? "Company-wide" : ctx.scope === "team" ? "Your team" : ctx.scope === "pipeline" ? "Your pipelines" : "Your own records";
  return (
    <>
      <PageHeader title="Analytics" description={`${scopeNote} · every number shows its basis (gross vs RTB net, MUU source, overrides).`} />
      <AnalyticsShell
          tabs={tabs}
          pipelines={pipes.map((p) => ({ value: p.key, label: p.name }))}
          owners={owners.map((o) => ({ value: o.id, label: o.name }))}
          netAllowed={ctx.netAllowed}
        >
          {children}
      </AnalyticsShell>
    </>
  );
}
