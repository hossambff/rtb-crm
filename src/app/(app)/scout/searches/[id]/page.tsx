import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { ConnectApify } from "@/components/scout/connect-apify";
import { SearchBuilder } from "@/components/scout/search-builder";
import { can, requireUser } from "@/lib/rbac/server";
import { criteriaSchema } from "@/lib/scout/criteria";
import { apifyStatus, getSearch } from "@/lib/scout/queries";
import { getScoutSettings } from "@/lib/scout/settings";

export const metadata = { title: "Edit scout search" };
export const maxDuration = 300;

export default async function EditSearchPage(props: PageProps<"/scout/searches/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const search = await getSearch(user, id);
  if (!search) notFound();
  const [apify, settings, configure] = await Promise.all([apifyStatus(), getScoutSettings(), can(user, "admin", "configure", "all")]);
  const parsed = criteriaSchema.safeParse(search.criteria);
  return (
    <>
      <PageHeader
        title={search.name}
        description="Edit filters and re-run. Only new domains are added to the review queue."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/scout?tab=searches">
              <ArrowLeft aria-hidden /> Searches
            </Link>
          </Button>
        }
      />
      {!apify.connected ? <ConnectApify canConfigure={configure} compact /> : null}
      <SearchBuilder
        apifyConnected={apify.connected}
        maxDomainsPerRun={settings.budget.maxDomainsPerRun}
        initial={{ id: search.id, name: search.name, schedule: search.schedule === "weekly" ? "weekly" : "once", criteria: parsed.success ? parsed.data : {} }}
      />
    </>
  );
}
