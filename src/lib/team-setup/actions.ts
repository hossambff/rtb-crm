"use server";
import { revalidatePath } from "next/cache";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/rbac/server";
import { notify } from "@/lib/notifications/notify";
import { allowedDomainList, provisionUser } from "@/lib/admin/provision";
import { isPlaceholderEmail } from "@/lib/admin/claim-plan";
import { env } from "@/lib/env";
import { forecastWindow } from "@/lib/forecast/core";
import { isSellingRole } from "@/lib/welcome/core";
import { metricsForMotion, QUOTA_METRICS, toStoredTarget } from "@/lib/quotas/core";
import { assignableRoles, validateInvite } from "./core";
import { inSetupScope, maySetQuotaFor, requireSetupScope } from "./scope";
import type { Role } from "@/lib/rbac/model";

function refresh() {
  revalidatePath("/admin/team-setup");
  revalidatePath("/team/setup");
}

const inviteRow = z.object({
  email: z.string().trim().max(200),
  name: z.string().trim().max(120),
  role: z.string().trim().max(40),
  team: z.string().trim().max(120).optional().default(""),
  manager: z.string().trim().max(200).optional().default(""),
  employment: z.string().trim().max(40).optional().default(""),
});

/**
 * Bulk invite (pre-provision). Every row is re-validated server-side against the inviter's rights: admins any
 * non-admin role (admin-level roles need a Super Admin); sales leaders seller roles into their own team only (they're
 * the default manager). Allowed domains, duplicate accounts and placeholder emails are rejected. Each user is audited.
 */
export const inviteMembers = action(z.object({ rows: z.array(inviteRow).min(1, "Add at least one person.").max(100, "Up to 100 at a time.") }), async ({ rows }, user) => {
  const scope = await requireSetupScope(user, { write: true });
  if (!scope.invite) throw new ForbiddenError("Ask an admin to invite people.");
  const [teams, people, existing, domainsDb] = await Promise.all([
    db.select({ id: s.teams.id, name: s.teams.name }).from(s.teams),
    db.select({ id: s.user.id, name: s.user.name, email: s.user.email, banned: s.user.banned }).from(s.user),
    db.select({ email: s.user.email }).from(s.user),
    allowedDomainList(),
  ]);
  const leader = scope.invite === "leader";
  const ctx = {
    teams,
    people: people.filter((p) => !p.banned && !isPlaceholderEmail(p.email)).filter((p) => !leader || scope.memberIds?.includes(p.id) || p.id === user.id),
    allowed: assignableRoles(scope.invite),
    existingEmails: new Set(existing.map((e) => e.email.toLowerCase())),
    domains: [...env.allowedDomains, ...domainsDb].map((d) => d.toLowerCase()),
    ...(leader ? { forcedTeamId: user.teamId, defaultManagerId: user.id } : {}),
  };
  const seen = new Set<string>();
  const results: { email: string; ok: boolean; error?: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const v = validateInvite({ line: i + 1, ...r }, ctx, seen);
    if (v.errors.length || !v.role) {
      results.push({ email: v.email || r.email, ok: false, error: v.errors.join("; ") || "Invalid row" });
      continue;
    }
    try {
      await provisionUser(
        user.id,
        { email: v.email, name: v.name, role: v.role, teamId: v.teamId, managerId: v.managerId, employmentType: v.employmentType },
        "team_setup.invite",
      );
      ctx.existingEmails.add(v.email);
      results.push({ email: v.email, ok: true });
    } catch (e) {
      if (e instanceof UserError || e instanceof ForbiddenError) results.push({ email: v.email, ok: false, error: e.message });
      else throw e;
    }
  }
  refresh();
  revalidatePath("/admin/users");
  return { results, invited: results.filter((r) => r.ok).length };
});

/** Nudge: an in-app notification (+ Slack DM through notify when the person has DMs on). At most once per 12 hours. */
export const nudgeMember = action(z.object({ userId: z.string().min(1).max(64) }), async ({ userId }, user) => {
  const scope = await requireSetupScope(user, { write: true });
  if (!inSetupScope(scope, userId) || userId === user.id) throw new ForbiddenError();
  const [target] = await db.select({ id: s.user.id, name: s.user.name, banned: s.user.banned, email: s.user.email }).from(s.user).where(eq(s.user.id, userId));
  if (!target || target.banned || isPlaceholderEmail(target.email)) throw new UserError("That person isn't active.");
  const since = new Date(Date.now() - 12 * 3_600_000);
  const recent = await db
    .select({ id: s.notifications.id })
    .from(s.notifications)
    .where(and(eq(s.notifications.userId, userId), eq(s.notifications.href, "/welcome"), gte(s.notifications.createdAt, since)))
    .limit(1);
  if (recent.length) throw new UserError(`${target.name.split(" ")[0]} was nudged in the last 12 hours.`);
  await notify(userId, {
    kind: "mention",
    title: `${user.name} asked you to finish setting up Roundtable`,
    body: "A few minutes: profile, what you sell, your targets and tools. Skip anything you can't do yet.",
    href: "/welcome",
  });
  await audit({ actorId: user.id, action: "team_setup.nudge", entity: "user", entityId: userId });
  return { nudged: target.name };
});

/** Set (or adjust) a quota → status "set". Leaders: their team only, never themselves. */
export const setQuota = action(
  z.object({
    userId: z.string().min(1).max(64),
    period: z.string().regex(/^\d{4}-Q[1-4]$/),
    pipelineKey: z.string().max(40),
    metric: z.enum(QUOTA_METRICS),
    target: z.number().min(0, "Targets can't be negative").max(1e12),
    note: z.string().trim().max(300).optional(),
  }),
  async (input, user) => {
    const scope = await requireSetupScope(user, { write: true });
    if (!maySetQuotaFor(user, scope, input.userId)) throw new ForbiddenError("You can set quotas for your team only (not your own).");
    const [target] = await db.select({ role: s.user.role, banned: s.user.banned }).from(s.user).where(eq(s.user.id, input.userId));
    if (!target || target.banned || !isSellingRole(target.role as Role)) throw new UserError("Quotas are for active sellers.");
    if (!metricsForMotion(input.pipelineKey).includes(input.metric)) throw new UserError("That metric doesn't fit this motion.");
    const { current, next } = forecastWindow(new Date(), user.timezone);
    if (input.period !== current && input.period !== next) throw new UserError("Set quotas for this quarter or next.");
    const existing = await db
      .select()
      .from(s.quotas)
      .where(and(eq(s.quotas.userId, input.userId), eq(s.quotas.period, input.period), eq(s.quotas.pipelineKey, input.pipelineKey)))
      .orderBy(asc(s.quotas.createdAt));
    const stored = toStoredTarget(input.metric, input.target);
    // One quota per line: a metric switch replaces the line's other metrics.
    const others = existing.filter((q) => q.metric !== input.metric);
    if (others.length) await db.delete(s.quotas).where(inArray(s.quotas.id, others.map((q) => q.id)));
    const [after] = await db
      .insert(s.quotas)
      .values({ userId: input.userId, period: input.period, pipelineKey: input.pipelineKey, metric: input.metric, target: stored, status: "set", setBy: user.id, note: input.note || null })
      .onConflictDoUpdate({
        target: [s.quotas.userId, s.quotas.period, s.quotas.pipelineKey, s.quotas.metric],
        set: { target: stored, status: "set", setBy: user.id, note: input.note || null },
      })
      .returning();
    await audit({ actorId: user.id, action: "quota.set", entity: "quota", entityId: after!.id, before: existing.length ? existing : null, after });
    if (input.userId !== user.id)
      await notify(input.userId, { kind: "mention", title: `${user.name} set your ${input.period.replace("-", " ")} target`, href: "/welcome?step=targets" });
    refresh();
    revalidatePath("/forecast");
    return { id: after!.id };
  },
);

/** Confirm a rep's proposal as is. */
export const confirmQuota = action(z.object({ id: z.string().uuid() }), async ({ id }, user) => {
  const scope = await requireSetupScope(user, { write: true });
  const [q] = await db.select().from(s.quotas).where(eq(s.quotas.id, id));
  if (!q) throw new UserError("Quota not found.");
  if (!maySetQuotaFor(user, scope, q.userId)) throw new ForbiddenError();
  if (q.status === "set") return { id };
  const [after] = await db.update(s.quotas).set({ status: "set", setBy: user.id }).where(eq(s.quotas.id, id)).returning();
  await audit({ actorId: user.id, action: "quota.confirm", entity: "quota", entityId: id, before: q, after });
  await notify(q.userId, { kind: "mention", title: `${user.name} confirmed your ${q.period.replace("-", " ")} target`, href: "/welcome?step=targets" });
  refresh();
  revalidatePath("/forecast");
  return { id };
});

/** Clear a quota line. */
export const clearQuota = action(z.object({ id: z.string().uuid() }), async ({ id }, user) => {
  const scope = await requireSetupScope(user, { write: true });
  const [q] = await db.select().from(s.quotas).where(eq(s.quotas.id, id));
  if (!q) return { id };
  if (!maySetQuotaFor(user, scope, q.userId)) throw new ForbiddenError();
  await db.delete(s.quotas).where(eq(s.quotas.id, id));
  await audit({ actorId: user.id, action: "quota.clear", entity: "quota", entityId: id, before: q, after: null });
  refresh();
  revalidatePath("/forecast");
  return { id };
});
