"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { decide } from "./service";

export const decideApproval = action(
  z.object({ id: z.string().uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).nullish() }),
  async ({ id, decision, note }, user) => {
    const row = await decide(user, id, decision, note || null);
    revalidatePath("/tasks");
    revalidatePath("/home");
    return { id: row.id, status: row.status };
  },
);
