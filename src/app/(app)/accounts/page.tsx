import { forbidden } from "next/navigation";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { AccountsList } from "@/components/accounts/accounts-list";
import { CreateAccountDialog } from "@/components/accounts/create-account-dialog";
import { accountFilterOptions, listAccounts, parseAccountListParams } from "@/lib/accounts/queries";
import { can, requireUser } from "@/lib/rbac/server";
import { fmtNumber } from "@/lib/format";

export const metadata = { title: "Accounts" };

export default async function AccountsPage(props: PageProps<"/accounts">) {
  const user = await requireUser();
  if (!(await can(user, "accounts", "view"))) forbidden();
  const sp = await props.searchParams;
  const params = parseAccountListParams(sp);
  const [list, opts, canCreate, canExport] = await Promise.all([
    listAccounts(user, params),
    accountFilterOptions(),
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
            {canCreate ? <CreateAccountDialog categories={opts.categories} owners={opts.owners} currentUserId={user.id} /> : null}
          </>
        }
      />
      <AccountsList
        rows={list.rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        categories={opts.categories}
        owners={opts.owners.map((o) => ({ id: o.id, name: o.name }))}
      />
    </>
  );
}
