"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action, UserError } from "@/lib/actions";
import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getSetting, setSetting } from "@/lib/settings";
import { decide } from "./service";
import { MAX_SLA_HOURS, MIN_SLA_HOURS, normalizeSlaSettings, SLA_SETTINGS_KEY } from "./sla-core";

export const decideApproval = action(
  z.object({ id: z.string().uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).nullish() }),
  async ({ id, decision, note }, user) => {
    const row = await decide(user, id, decision, note || null);
    revalidatePath("/tasks");
    revalidatePath("/home");
    return { id: row.id, status: row.status };
  },
);

const hours = z.number().int().min(MIN_SLA_HOURS, `At least ${MIN_SLA_HOURS} hour`).max(MAX_SLA_HOURS, `At most ${MAX_SLA_HOURS} hours`);

/** Admin: approval SLA per kind (C7). New requests use it; pending rows keep the due date they were given. */
export const saveApprovalSla = action(
  z.object({
    hours: z.record(z.string().regex(/^[a-z_]{1,40}$/), hours),
    defaultHours: hours,
    pauseWeekends: z.boolean(),
    timezone: z.string().min(1).max(60),
  }),
  async (input, user) => {
    await requireAdmin(user);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      throw new UserError("Unknown time zone. Use an IANA name like America/New_York.");
    }
    const before = normalizeSlaSettings(await getSetting<unknown>(SLA_SETTINGS_KEY, null));
    const next = normalizeSlaSettings(input);
    await setSetting(SLA_SETTINGS_KEY, next, user.id);
    await audit({ actorId: user.id, action: "settings.approvals_sla", entity: "app_settings", entityId: SLA_SETTINGS_KEY, before, after: next });
    revalidatePath("/admin/slack");
    revalidatePath("/tasks");
    return next;
  },
);
