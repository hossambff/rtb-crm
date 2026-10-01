import "server-only";
import { revalidatePath } from "next/cache";
import { logServerError } from "@/lib/errors";
import type { AppUser } from "@/lib/rbac/server";
import { helpHref, isOverdue } from "@/lib/help/core";
import { UserError } from "@/lib/actions";
import { activeHelpFor, respondHelpRequest } from "@/lib/help/service";
import type { QueueItem, QueueServerHandler } from "../types";

/**
 * Today queue — executive help requests (V2 §C6):
 *  - target: open asks ("Accept" one click; decline/done need a response → on the deal) and accepted ones still to do;
 *  - requester: asks past their needed-by date that are still open/accepted → follow up.
 * Context text was written for the target at creation (restricted deals only reach people on the access list).
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const rows = await activeHelpFor(user.id);
    const now = new Date();
    const items: QueueItem[] = [];
    for (const r of rows) {
      const href = helpHref(r); // meeting-only asks open /help/<id> (QA MAJ-08)
      const overdue = isOverdue(r, now);
      const dealLine = r.context?.split("\n")[0]?.replace(/^Deal: /, "") ?? null;
      if (r.target.id === user.id) {
        items.push({
          key: `help:${r.id}`,
          kind: "help",
          title: r.status === "open" ? `${r.requester.name} needs your help` : `You said you'd help ${r.requester.name}`,
          detail: r.ask.slice(0, 160),
          context: dealLine,
          href,
          dueAt: r.neededBy,
          urgency: overdue ? 85 : r.status === "open" ? 70 : 55,
          severity: overdue ? "serious" : null,
          actions:
            r.status === "open"
              ? [
                  { kind: "server", label: "Accept", actionId: "help.accept", payload: { id: r.id }, primary: true },
                  { kind: "link", label: "Respond", href },
                  { kind: "snooze" },
                ]
              : // Closing needs a response for the requester (QA MAJ-08 / lead): open the request to write it.
                [{ kind: "link", label: "Respond & close", href }, { kind: "snooze" }],
        });
      } else if (r.requester.id === user.id && overdue) {
        items.push({
          key: `help:${r.id}:overdue`,
          kind: "help",
          title: `${r.target.name} hasn't ${r.status === "open" ? "answered" : "closed"} your help request`,
          detail: r.ask.slice(0, 160),
          context: dealLine,
          href,
          dueAt: r.neededBy,
          urgency: 60,
          severity: "warning",
          actions: [{ kind: "link", label: "Follow up", href }, { kind: "done" }, { kind: "snooze" }],
        });
      }
    }
    return items;
  } catch (e) {
    logServerError("queue.help", e);
    return [];
  }
}

/** Server handlers referenced as "help.<name>". */
export const actions: Record<string, QueueServerHandler> = {
  accept: async (user, payload) => {
    const res = await respondHelpRequest(user, { id: String(payload.id ?? ""), status: "accepted" });
    if (res.dealId) revalidatePath(`/deals/${res.dealId}`);
    return { message: "Accepted — they've been told you're on it" };
  },
  done: async (user, payload) => {
    const response = String(payload.response ?? "").trim();
    if (response.length < 3) throw new UserError("Add a short response before closing — open the request to write it.");
    const res = await respondHelpRequest(user, { id: String(payload.id ?? ""), status: "done", response });
    if (res.dealId) revalidatePath(`/deals/${res.dealId}`);
    return { message: "Marked done" };
  },
};
