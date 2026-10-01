import { and, eq, inArray, or } from "drizzle-orm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import * as s from "@/db/schema";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { can, dealAccessWhere, getCurrentUser } from "@/lib/rbac/server";
import { dealEnrollments, listEnrollments, type EnrollmentRow } from "@/lib/sequences/queries";
import { EnrollDialog } from "./enroll-dialog";
import { EnrollmentsTable } from "./enrollments-table";

type Choice = { id: string; name: string; detail: string; disabledReason: string | null };

async function safe<T>(label: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[${label}]`, e instanceof Error ? e.message.slice(0, 160) : "error");
    return null;
  }
}

async function loadDealPanel(dealId: string) {
  const user = await getCurrentUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(dealId) || !(await can(user, "email", "view"))) return null;
  const [deal] = await db.select({ id: s.deals.id, primary: s.deals.primaryContactId, status: s.deals.status }).from(s.deals).where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
  if (!deal) return null;
  const visible = await contactVisibilityWhere(user);
  const linkIds = (await db.select({ id: s.dealContacts.contactId }).from(s.dealContacts).where(eq(s.dealContacts.dealId, dealId))).map((r) => r.id);
  const ids = [...new Set([...(deal.primary ? [deal.primary] : []), ...linkIds])];
  const [contacts, enrollments] = await Promise.all([
    ids.length
      ? db
          .select({ id: s.contacts.id, fullName: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email, dnc: s.contacts.doNotContact, status: s.contacts.status })
          .from(s.contacts)
          .where(and(inArray(s.contacts.id, ids), visible))
      : Promise.resolve([]),
    dealEnrollments(user, dealId),
  ]);
  const activeFor = new Set(enrollments.filter((e) => e.status === "active" || e.status === "paused").map((e) => e.contactId));
  const choices: Choice[] = contacts.map((c) => ({
    id: c.id,
    name: c.fullName,
    detail: [c.title, c.email].filter(Boolean).join(" · "),
    disabledReason: c.dnc ? "Do not contact" : c.status === "left_company" ? "Left the company" : !c.email ? "No email address" : activeFor.has(c.id) ? "Already in a sequence" : null,
  }));
  const defaults = choices.filter((c) => !c.disabledReason && (c.id === deal.primary || choices.length === 1)).map((c) => c.id);
  return { open: deal.status === "open", choices, defaults, enrollments };
}

/**
 * Deal page slot (owner WS-D): enrollments for this deal and its contacts + "Enroll" (pick which deal contacts).
 * Async server component; does its own permission checks (deal access incl. MNPI lists, contact visibility, email
 * module) and renders null when not applicable. Never throws.
 */
export async function DealSequencesPanel({ dealId }: { dealId: string }) {
  const d = await safe("DealSequencesPanel", () => loadDealPanel(dealId));
  if (!d) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Sequences</CardTitle>
          <CardDescription>{d.enrollments.length ? "Cadences running for this deal’s contacts." : "No one on this deal is in a sequence."}</CardDescription>
        </div>
        {d.open && d.choices.some((c) => !c.disabledReason) ? <EnrollDialog choices={d.choices} defaultChoiceIds={d.defaults} dealId={dealId} source="deal" label="Enroll" /> : null}
      </CardHeader>
      {d.enrollments.length ? (
        <CardContent className="p-3">
          <EnrollmentsTable rows={d.enrollments} showSequence compact />
        </CardContent>
      ) : null}
    </Card>
  );
}

async function loadContactPanel(contactId: string): Promise<{ rows: EnrollmentRow[]; busy: boolean; blocked: string | null } | null> {
  const user = await getCurrentUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(contactId) || !(await can(user, "email", "view"))) return null;
  const [c] = await db
    .select({ id: s.contacts.id, dnc: s.contacts.doNotContact, email: s.contacts.email, status: s.contacts.status, accountDnc: s.accounts.doNotContact })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(and(eq(s.contacts.id, contactId), await contactVisibilityWhere(user)));
  if (!c) return null;
  const rows = await listEnrollments(user, { contactId, limit: 20 });
  return {
    rows,
    busy: rows.some((r) => r.status === "active" || r.status === "paused"),
    blocked: c.dnc || c.accountDnc ? "Do not contact" : c.status === "left_company" ? "Left the company" : !c.email ? "No email address" : null,
  };
}

/** Contact page panel (Integration request: mount on /contacts/[id]): this contact's enrollments + Enroll. */
export async function ContactSequencesPanel({ contactId }: { contactId: string }) {
  const d = await safe("ContactSequencesPanel", () => loadContactPanel(contactId));
  if (!d) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Sequences</CardTitle>
          <CardDescription>{d.blocked ?? (d.busy ? "In a sequence now." : d.rows.length ? "Past cadences." : "Not in a sequence.")}</CardDescription>
        </div>
        {!d.blocked && !d.busy ? <EnrollDialog target={{ contactIds: [contactId] }} source="contact" label="Enroll" /> : null}
      </CardHeader>
      {d.rows.length ? (
        <CardContent className="p-3">
          <EnrollmentsTable rows={d.rows} showSequence compact />
        </CardContent>
      ) : null}
    </Card>
  );
}

async function loadAccountChoices(accountId: string): Promise<Choice[] | null> {
  const user = await getCurrentUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(accountId) || !(await can(user, "email", "view"))) return null;
  const visible = await contactVisibilityWhere(user);
  const contacts = await db
    .select({ id: s.contacts.id, fullName: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email, dnc: s.contacts.doNotContact })
    .from(s.contacts)
    .innerJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(and(eq(s.contacts.accountId, accountId), eq(s.contacts.status, "active"), eq(s.accounts.doNotContact, false), visible))
    .limit(100);
  if (!contacts.length) return null;
  const active = new Set(
    (
      await db
        .select({ id: s.sequenceEnrollments.contactId })
        .from(s.sequenceEnrollments)
        .where(and(inArray(s.sequenceEnrollments.contactId, contacts.map((c) => c.id)), or(eq(s.sequenceEnrollments.status, "active"), eq(s.sequenceEnrollments.status, "paused"))))
    ).map((r) => r.id),
  );
  const choices = contacts.map((c) => ({ id: c.id, name: c.fullName, detail: [c.title, c.email].filter(Boolean).join(" · "), disabledReason: c.dnc ? "Do not contact" : !c.email ? "No email address" : active.has(c.id) ? "Already in a sequence" : null }));
  return choices.some((c) => !c.disabledReason) ? choices : null;
}

/** Account page button (Integration request: mount on /accounts/[id] header): enroll the account's active contacts. */
export async function AccountEnrollButton({ accountId }: { accountId: string }) {
  const choices = await safe("AccountEnrollButton", () => loadAccountChoices(accountId));
  if (!choices) return null;
  return <EnrollDialog choices={choices} source="account" label="Enroll in sequence" />;
}
