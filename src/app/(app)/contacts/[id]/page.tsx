import { Suspense } from "react";
import { ContactSequencesPanel } from "@/components/sequences/deal-sequences";
import { AccountCollisionNotice } from "@/components/deals/touches/collision-notice";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink, Mail, Phone, UserX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { ActivityTimeline } from "@/components/accounts/activity-timeline";
import { ContactFormDialog } from "@/components/contacts/contact-form-dialog";
import { DealLinks } from "@/components/contacts/deal-links";
import { ownerFilterOptions } from "@/lib/users";
import { getContactDetail } from "@/lib/contacts/queries";
import { seniorityLabel } from "@/lib/contacts/seniority";
import { fmtDate, fmtRelative } from "@/lib/format";
import { can, requireUser } from "@/lib/rbac/server";

const loadContact = cache(async (id: string) => getContactDetail(await requireUser(), id));

export async function generateMetadata({ params }: PageProps<"/contacts/[id]">) {
  const user = await requireUser();
  if (!(await can(user, "contacts", "view"))) return { title: "Contact" };
  const d = await loadContact((await params).id);
  return { title: d?.contact.fullName ?? "Contact" };
}

export default async function ContactPage(props: PageProps<"/contacts/[id]">) {
  const user = await requireUser();
  if (!(await can(user, "contacts", "view"))) notFound();
  const { id } = await props.params;
  const data = await loadContact(id);
  if (!data) notFound();
  const { contact: c } = data;
  const owners = (await ownerFilterOptions()).map((o) => ({ id: o.id, name: o.name }));
  const emails = [c.email, ...(c.altEmails ?? [])].filter((e): e is string => !!e);

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-xs text-muted">
        <Link href="/contacts" className="-my-2 shrink-0 py-2 hover:text-fg">
          Contacts
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="min-w-0 truncate text-secondary">{c.fullName}</span>
      </nav>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={c.fullName} size={44} />
          <div className="min-w-0">
            <h1 className="break-words font-display text-2xl font-medium leading-8 text-fg sm:text-[28px] sm:leading-9">{c.fullName}</h1>
            <p className="mt-0.5 text-sm text-secondary">
              {c.title ?? "No title"}
              {data.account ? (
                <>
                  {" "}
                  at{" "}
                  <Link href={`/accounts/${data.account.id}`} className="text-fg underline-offset-4 hover:underline">
                    {data.account.name}
                  </Link>
                </>
              ) : null}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge>{c.status === "left_company" ? "Left company" : "Active"}</Badge>
              {c.seniority ? <Badge>{seniorityLabel(c.seniority)}</Badge> : null}
              {c.doNotContact || data.account?.doNotContact ? (
                <Badge>
                  <UserX className="size-3" /> Do not contact{!c.doNotContact ? " (account)" : ""}
                </Badge>
              ) : null}
              {c.origin ? <Badge>{c.origin}</Badge> : null}
            </div>
            {data.account ? (
              <div className="mt-2 empty:hidden">
                <Suspense fallback={null}>
                  <AccountCollisionNotice user={user} accountId={data.account.id} />
                </Suspense>
              </div>
            ) : null}
          </div>
        </div>
        {data.canEdit ? (
          <ContactFormDialog
            trigger="edit"
            owners={owners}
            initial={{
              id: c.id,
              fullName: c.fullName,
              account: data.account ? { id: data.account.id, name: data.account.name } : null,
              title: c.title,
              seniority: c.seniority,
              email: c.email,
              altEmails: c.altEmails ?? [],
              phone: c.phone,
              linkedinUrl: c.linkedinUrl,
              relationshipOwnerId: c.relationshipOwnerId,
              status: c.status,
              doNotContact: c.doNotContact,
              notes: c.notes,
            }}
          />
        ) : null}
      </header>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <Row label={emails.length > 1 ? "Emails" : "Email"}>
                  {emails.length ? (
                    <ul className="space-y-0.5">
                      {emails.map((e, i) => (
                        <li key={e}>
                          <a href={`mailto:${e}`} className="inline-flex items-center gap-1 text-fg hover:underline">
                            <Mail className="size-3 text-muted" aria-hidden /> {e}
                          </a>
                          {i === 0 && emails.length > 1 ? <span className="ml-1 text-[11px] text-muted">primary</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="Phone">
                  {c.phone ? (
                    <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 text-fg">
                      <Phone className="size-3 text-muted" aria-hidden /> {c.phone}
                    </a>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="LinkedIn">
                  {c.linkedinUrl ? (
                    <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg hover:underline">
                      Profile <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="Relationship owner">{data.relOwner?.name ?? "—"}</Row>
                <Row label="Record owner">{data.owner?.name ?? "—"}</Row>
                <Row label="Last contacted">{c.lastContactedAt ? `${fmtRelative(c.lastContactedAt)} (${fmtDate(c.lastContactedAt)})` : "—"}</Row>
                <Row label="Email status">{c.emailStatus ?? "unknown"}</Row>
              </dl>
              {c.notes ? <p className="mt-4 whitespace-pre-line border-t border-border pt-3 text-sm text-body">{c.notes}</p> : null}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Deals & roles</CardTitle>
            </CardHeader>
            <CardContent>
              <DealLinks contactId={c.id} deals={data.deals} accountDeals={data.accountDeals} canEdit={data.canEdit} />
            </CardContent>
          </Card>
          <Suspense fallback={null}>
            <ContactSequencesPanel contactId={c.id} />
          </Suspense>
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityTimeline items={data.activities} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[130px_1fr] sm:gap-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-secondary">{children}</dd>
    </div>
  );
}
