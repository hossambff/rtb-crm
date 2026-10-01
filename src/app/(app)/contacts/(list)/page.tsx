import { Suspense } from "react";
import { ContactsListSkeleton } from "./list-skeleton";
import { forbidden, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { ContactFormDialog } from "@/components/contacts/contact-form-dialog";
import { ContactsList } from "@/components/contacts/contacts-list";
import { activeOwnerOptions, ownerFilterOptions } from "@/lib/users";
import { listContacts, parseContactListParams } from "@/lib/contacts/queries";
import { fmtNumber } from "@/lib/format";
import { resolveListView } from "@/lib/views/queries";
import { SavedViewsMenu } from "@/components/views/saved-views-menu";
import { can, requireUser } from "@/lib/rbac/server";

export const metadata = { title: "Contacts" };

/**
 * QA B8 / MIN-40: guards and the saved-view redirect run BEFORE anything streams (real 403 / 307); the list itself
 * loads inside a Suspense boundary (no route-level loading.tsx, which would turn the redirect into a soft one).
 */
export default async function ContactsPage(props: PageProps<"/contacts">) {
  const user = await requireUser();
  if (!(await can(user, "contacts", "view"))) forbidden();
  const sp = await props.searchParams;
  const viewQs = await resolveListView(user, "contacts", sp, { teamValue: "team" }); // V2 §B8 (empty query only — no loop)
  if (viewQs) redirect(`/contacts${viewQs}`);
  return (
    <Suspense fallback={<ContactsListSkeleton />}>
      <ContactsData sp={sp} />
    </Suspense>
  );
}

async function ContactsData({ sp }: { sp: Awaited<PageProps<"/contacts">["searchParams"]> }) {
  const user = await requireUser();
  const params = parseContactListParams(sp);
  const [list, owners, activeOwners, canCreate, canExport, canEnroll] = await Promise.all([
    listContacts(user, params),
    ownerFilterOptions(),
    activeOwnerOptions(),
    can(user, "contacts", "create"),
    can(user, "export", "export"),
    can(user, "email", "view"),
  ]);
  const ownerOpts = owners.map((o) => ({ id: o.id, name: o.name }));
  const exportQs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && v ? [[k, v]] : [])));
  exportQs.set("entity", "contacts");
  return (
    <>
      <PageHeader
        title="Contacts"
        description={`${fmtNumber(list.total)} ${list.total === 1 ? "person" : "people"} across your accounts`}
        actions={
          <>
            {canExport ? (
              <Button asChild variant="secondary" size="sm">
                <a href={`/api/import/export?${exportQs.toString()}`}>
                  <Download /> Export
                </a>
              </Button>
            ) : null}
            {canCreate ? <ContactFormDialog owners={activeOwners.map((o) => ({ id: o.id, name: o.name }))} /> : null}
          </>
        }
      />
      <ContactsList
        rows={list.rows.map((r) => ({ ...r, lastContactedAt: r.lastContactedAt?.toISOString() ?? null }))}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        owners={ownerOpts}
        canEnroll={canEnroll}
        toolbarExtra={
          <Suspense fallback={null}>
            <SavedViewsMenu page="contacts" />
          </Suspense>
        }
      />
    </>
  );
}
