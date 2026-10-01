"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { confirmForecastEntries } from "./confirm";
import { CATEGORIES } from "./core";

const itemSchema = z.object({
  dealId: z.string().uuid(),
  category: z.enum(CATEGORIES),
  note: z.string().trim().max(500).optional(),
});

/**
 * Confirm or override this week's forecast for up to 500 deals (confirm-all sends the suggestions; an override sends
 * the rep's category + reason). Permission: edit access to each deal. Reasons are enforced server-side.
 */
export const confirmForecast = action(z.object({ items: z.array(itemSchema).min(1).max(500) }), async ({ items }, user) => {
  const res = await confirmForecastEntries(user, items);
  revalidatePath("/forecast");
  return res;
});
