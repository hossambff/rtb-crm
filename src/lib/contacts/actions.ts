"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, dealAccessWhere, dealModule, inScope, type AppUser } from "@/lib/rbac/server";
import { getVisibleAccount } from "@/lib/accounts/queries";
import { contactVisibilityWhere } from "./queries";
import { splitName } from "./seniority";

const email = z.string().trim().toLowerCase().email("Enter a valid email");
const opt = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const contactFields = {
  fullName: z.string().trim().min(1, "Name is required").max(160),
  accountId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  title: opt(160),
  seniority: z.enum(["c_level", "vp", "director", "manager", "individual"]).optional().nullable().or(z.literal("").transform(() => null)),
  email: email.optional().nullable().or(z.literal("").transform(() => null)),
  altEmails: z.array(email).max(10).optional().default([]),
  phone: opt(40),
  linkedinUrl: z.string().trim().url("Enter a full URL (https://…)").max(500).optional().nullable().or(z.literal("").transform(() => null)),
  relationshipOwnerId: opt(80),
  status: z.enum(["active", "left_company"]).default("active"),
  doNotContact: z.boolean().default(false),
  notes: opt(5000),
};

async function assertAccountUsable(user: AppUser, accountId: string | null | undefined) {
  if (!accountId) return;
  const acc = await getVisibleAccount(user, accountId);
  if (!acc) throw new UserError("That account isn't available.");
}

/** SEC M-1: email uniqueness is global, but the owner's name is only revealed when the caller can see that contact. */
async function emailTaken(user: AppUser, address: string | null | undefined, excludeId?: string) {
  if (!address) return null;
  const visible = await contactVisibilityWhere(user);
  const [hit] = await db
    .select({ id: s.contacts.id, fullName: s.contacts.fullName, visible: sql<boolean>`${visible}` })
    .from(s.contacts)
    .where(and(isNull(s.contacts.deletedAt), sql`lower(${s.contacts.email}) = ${address.toLowerCase()}`, excludeId ? ne(s.contacts.id, excludeId) : undefined));
  if (!hit) return null;
  return { id: hit.id, fullName: hit.visible ? hit.fullName : "Another contact you can't see" };
}

export const createContact = action(z.object(contactFields), async (input, user) => {
  await assertCan(user, "contacts", "create");
  await assertAccountUsable(user, input.accountId);
  const dup = await emailTaken(user, input.email);
  if (dup) throw new UserError(`${dup.fullName} already has this email — open that contact instead.`);
  const { firstName, lastName } = splitName(input.fullName);
  const [row] = await db
    .insert(s.contacts)
    .values({ ...input, altEmails: input.altEmails.filter((e) => e !== input.email), firstName, lastName, ownerId: user.id, origin: "manual" })
    .returning();
  await audit({ actorId: user.id, action: "contact.create", entity: "contact", entityId: row!.id, after: row });
  revalidatePath("/contacts");
  if (input.accountId) revalidatePath(`/accounts/${input.accountId}`);
  return { id: row!.id };
});

async function loadEditable(user: AppUser, id: string) {
  const scope = await assertCan(user, "contacts", "edit");
  const visible = await contactVisibilityWhere(user);
  const [c] = await db.select().from(s.contacts).where(and(eq(s.contacts.id, id), visible));
  if (!c || !inScope(user, scope, { ownerId: c.ownerId })) throw new UserError("You can't edit this contact.");
  return c;
}

export const updateContact = action(z.object({ id: z.string().uuid(), ...contactFields }), async (input, user) => {
  const before = await loadEditable(user, input.id);
  if (input.accountId !== before.accountId) await assertAccountUsable(user, input.accountId);
  const dup = await emailTaken(user, input.email, input.id);
  if (dup) throw new UserError(`${dup.fullName} already has this email.`);
  const { id, ...fields } = input;
  const { firstName, lastName } = splitName(input.fullName);
  const [after] = await db
    .update(s.contacts)
    .set({ ...fields, altEmails: fields.altEmails.filter((e) => e !== fields.email), firstName, lastName })
    .where(eq(s.contacts.id, id))
    .returning();
  await audit({ actorId: user.id, action: "contact.update", entity: "contact", entityId: id, before, after });
  revalidatePath(`/contacts/${id}`);
  revalidatePath("/contacts");
  if (after?.accountId) revalidatePath(`/accounts/${after.accountId}`);
  return { id };
});

async function editableDeal(user: AppUser, dealId: string) {
  const [d] = await db
    .select({ id: s.deals.id, name: s.deals.name, accountId: s.deals.accountId, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "edit")));
  if (!d) throw new UserError("You can't edit that deal.");
  await assertCan(user, dealModule(d.pipelineKey), "edit");
  return d;
}

const ROLE = z.enum(["decision_maker", "champion", "influencer", "legal", "tech", "blocker", "finance"]).optional().nullable().or(z.literal("").transform(() => null));

export const linkContactToDeal = action(z.object({ contactId: z.string().uuid(), dealId: z.string().uuid(), role: ROLE, makePrimary: z.boolean().optional() }), async (input, user) => {
  const deal = await editableDeal(user, input.dealId);
  const visible = await contactVisibilityWhere(user);
  const [c] = await db.select({ id: s.contacts.id }).from(s.contacts).where(and(eq(s.contacts.id, input.contactId), visible));
  if (!c) throw new UserError("Contact not found.");
  const [prev] = await db.select().from(s.dealContacts).where(and(eq(s.dealContacts.dealId, deal.id), eq(s.dealContacts.contactId, c.id)));
  await db
    .insert(s.dealContacts)
    .values({ dealId: deal.id, contactId: c.id, role: input.role ?? null })
    .onConflictDoUpdate({ target: [s.dealContacts.dealId, s.dealContacts.contactId], set: { role: input.role ?? null } });
  if (input.makePrimary) await db.update(s.deals).set({ primaryContactId: c.id }).where(eq(s.deals.id, deal.id));
  await audit({ actorId: user.id, action: "deal_contact.link", entity: "deal", entityId: deal.id, before: prev ?? null, after: { contactId: c.id, role: input.role ?? null, makePrimary: !!input.makePrimary } });
  revalidatePath(`/contacts/${c.id}`);
  return { ok: true };
});

export const unlinkContactFromDeal = action(z.object({ contactId: z.string().uuid(), dealId: z.string().uuid() }), async (input, user) => {
  const deal = await editableDeal(user, input.dealId);
  const [prev] = await db.select().from(s.dealContacts).where(and(eq(s.dealContacts.dealId, deal.id), eq(s.dealContacts.contactId, input.contactId)));
  if (!prev) return { ok: true };
  await db.delete(s.dealContacts).where(and(eq(s.dealContacts.dealId, deal.id), eq(s.dealContacts.contactId, input.contactId)));
  await audit({ actorId: user.id, action: "deal_contact.unlink", entity: "deal", entityId: deal.id, before: prev });
  revalidatePath(`/contacts/${input.contactId}`);
  return { ok: true };
});
