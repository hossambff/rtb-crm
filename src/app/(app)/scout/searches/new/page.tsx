import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { ConnectApify } from "@/components/scout/connect-apify";
import { SearchBuilder } from "@/components/scout/search-builder";
import { can, requireUser } from "@/lib/rbac/server";
import { apifyStatus } from "@/lib/scout/queries";
import { getScoutSettings } from "@/lib/scout/settings";

export const metadata = { title: "New scout search" };
export const maxDuration = 300;

export default async function NewSearchPage() {
  const user = await requireUser();
  if (!(await can(user, "scout", "create"))) return <EmptyState title="No access" description="Your role can't create Lead Scout searches." />;
  const [apify, settings, configure] = await Promise.all([apifyStatus(), getScoutSettings(), can(user, "admin", "configure", "all")]);
  return (
    <>
      <PageHeader
        title="New scout search"
        description="Filters, a plain-English description, lookalikes or a domain list — then estimate the cost and run."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/scout?tab=searches">
              <ArrowLeft aria-hidden /> Searches
            </Link>
          </Button>
        }
      />
      {!apify.connected ? <ConnectApify canConfigure={configure} compact /> : null}
      <SearchBuilder apifyConnected={apify.connected} maxDomainsPerRun={settings.budget.maxDomainsPerRun} />
    </>
  );
}
