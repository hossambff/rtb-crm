import { Suspense } from "react";
import { AccountsListSkeleton } from "./list-skeleton";
import { forbidden, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { AccountsList } from "@/components/accounts/accounts-list";
import { CreateAccountDialog } from "@/components/accounts/create-account-dialog";
import { accountFilterOptions, listAccounts, parseAccountListParams } from "@/lib/accounts/queries";
import { activeOwnerOptions, ownerFilterOptions } from "@/lib/users";
import { can, requireUser } from "@/lib/rbac/server";
import { fmtNumber } from "@/lib/format";
import { resolveListView } from "@/lib/views/queries";
import { SavedViewsMenu } from "@/components/views/saved-views-menu";

export const metadata = { title: "Accounts" };

/**
 * QA B8 / MIN-40: guards and the saved-view redirect run BEFORE anything streams (real 403 / 307); the list itself
 * loads inside a Suspense boundary (no route-level loading.tsx, which would turn the redirect into a soft one).
 */
export default async function AccountsPage(props: PageProps<"/accounts">) {
  const user = await requireUser();
  if (!(await can(user, "accounts", "view"))) forbidden();
  const sp = await props.searchParams;
  const viewQs = await resolveListView(user, "accounts", sp, { teamValue: "team" }); // V2 §B8 (empty query only — no loop)
  if (viewQs) redirect(`/accounts${viewQs}`);
  return (
    <Suspense fallback={<AccountsListSkeleton />}>
      <AccountsData sp={sp} />
    </Suspense>
  );
}

async function AccountsData({ sp }: { sp: Awaited<PageProps<"/accounts">["searchParams"]> }) {
  const user = await requireUser();
  const params = parseAccountListParams(sp);
  const [list, opts, filterOwners, activeOwners, canCreate, canExport] = await Promise.all([
    listAccounts(user, params),
    accountFilterOptions(),
    ownerFilterOptions(),
    activeOwnerOptions(),
    can(user, "accounts", "create"),
    can(user, "export", "export"),
  ]);
  const exportQs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && v ? [[k, v]] : [])));
  exportQs.set("entity", "accounts");
  return (
    <>
      <PageHeader
        title="Accounts"
        description={`${fmtNumber(list.total)} ${list.total === 1 ? "account" : "brands and companies"} across every motion`}
        actions={
          <>
            {canExport ? (
              <Button asChild variant="secondary" size="sm">
                <a href={`/api/import/export?${exportQs.toString()}`}>
                  <Download /> Export
                </a>
              </Button>
            ) : null}
            {canCreate ? <CreateAccountDialog categories={opts.categories} owners={activeOwners} currentUserId={user.id} /> : null}
          </>
        }
      />
      <AccountsList
        rows={list.rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        categories={opts.categories}
        owners={filterOwners.map((o) => ({ id: o.id, name: o.name }))}
        toolbarExtra={
          <Suspense fallback={null}>
            <SavedViewsMenu page="accounts" />
          </Suspense>
        }
      />
    </>
  );
}
