import "server-only";
import type { AppUser } from "@/lib/rbac/server";
import { logServerError } from "@/lib/errors";
import { pendingStoryPrompts } from "@/lib/team/queries";
import type { QueueItem } from "../types";

/**
 * Today-queue provider: "Share the story" for deals the user won/lost in the last week (prompts created by the tick job
 * detectClosedDealsForStories). One indexed query; permission- and MNPI-safe (dealAccessWhere); never throws.
 * Done/snooze go to queue_snoozes via the generic actions (key "story:<dealId>").
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const prompts = await pendingStoryPrompts(user, 5);
    return prompts.map((p) => {
      const won = p.status === "won";
      const href = `/team?share=${p.dealId}`;
      return {
        key: `story:${p.dealId}`,
        kind: "story" as const,
        title: won ? `Share the win: ${p.dealName}` : `Share the lesson: ${p.dealName}`,
        detail: won ? "Two minutes — the draft is ready. Tell the team what worked." : "Two minutes — the draft is ready. What would we do differently?",
        context: p.pipelineKey,
        href,
        urgency: won ? 30 : 25,
        severity: "info" as const,
        actions: [{ kind: "link" as const, label: "Share the story", href }, { kind: "snooze" as const }, { kind: "done" as const }],
      };
    });
  } catch (e) {
    logServerError("queue.stories", e);
    return [];
  }
}
