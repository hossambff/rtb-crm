import { forbidden } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { ContactFormDialog } from "@/components/contacts/contact-form-dialog";
import { ContactsList } from "@/components/contacts/contacts-list";
import { assignableUsers } from "@/lib/accounts/queries";
import { listContacts, parseContactListParams } from "@/lib/contacts/queries";
import { fmtNumber } from "@/lib/format";
import { can, requireUser } from "@/lib/rbac/server";

export const metadata = { title: "Contacts" };

export default async function ContactsPage(props: PageProps<"/contacts">) {
  const user = await requireUser();
  if (!(await can(user, "contacts", "view"))) forbidden();
  const sp = await props.searchParams;
  const params = parseContactListParams(sp);
  const [list, owners, canCreate, canExport] = await Promise.all([listContacts(user, params), assignableUsers(), can(user, "contacts", "create"), can(user, "export", "export")]);
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
            {canCreate ? <ContactFormDialog owners={ownerOpts} /> : null}
          </>
        }
      />
      <ContactsList
        rows={list.rows.map((r) => ({ ...r, lastContactedAt: r.lastContactedAt?.toISOString() ?? null }))}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        owners={ownerOpts}
      />
    </>
  );
}
