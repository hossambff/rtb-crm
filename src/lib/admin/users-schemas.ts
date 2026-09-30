/** Zod schemas for user administration (pure; shared by server actions and client forms). */
import { z } from "zod";
import { ROLES } from "@/lib/rbac/model";

export const EMPLOYMENT_TYPES = ["staff", "retainer", "hourly", "commission", "contractor"] as const;
export const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== "pending");
/** Roles whose grant/revoke is security-sensitive (super_admin only). */
export const PRIVILEGED_ROLES = ["super_admin", "admin"] as const;

const optionalId = z
  .string()
  .trim()
  .max(64)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));
const optionalDate = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v == null || !Number.isNaN(new Date(v).getTime()), "Enter a valid date.");

export const preProvisionSchema = z.object({
  email: z
    .email("Enter a valid email address.")
    .trim()
    .transform((v) => v.toLowerCase()),
  name: z.string().trim().min(2, "Enter the person's name.").max(120),
  title: z.string().trim().max(120).optional().nullable(),
  role: z.enum(ASSIGNABLE_ROLES as [string, ...string[]]),
  teamId: optionalId,
  managerId: optionalId,
  employmentType: z.enum(EMPLOYMENT_TYPES),
  accessExpiresAt: optionalDate,
});

export const changeRoleSchema = z.object({ userId: z.string().min(1).max(64), role: z.enum(ASSIGNABLE_ROLES as [string, ...string[]]) });

export const updateUserOrgSchema = z.object({
  userId: z.string().min(1).max(64),
  name: z.string().trim().min(2, "Enter a name.").max(120),
  title: z.string().trim().max(120).optional().nullable(),
  teamId: optionalId,
  managerId: optionalId,
  employmentType: z.enum(EMPLOYMENT_TYPES),
  accessExpiresAt: optionalDate,
});

export const deactivateSchema = z.object({
  userId: z.string().min(1).max(64),
  reassignTo: optionalId,
  reason: z.string().trim().max(200).optional().nullable(),
  include: z.object({ deals: z.boolean(), tasks: z.boolean(), accounts: z.boolean(), contacts: z.boolean() }),
});

export const userIdSchema = z.object({ userId: z.string().min(1).max(64) });

export const claimSchema = z.object({ placeholderId: z.string().min(1).max(64), targetUserId: z.string().min(1, "Choose the real user.").max(64) });
