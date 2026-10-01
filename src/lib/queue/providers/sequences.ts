import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { AppUser } from "@/lib/rbac/server";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { manageableEnrollments, resumeSystemPaused, setEnrollmentState } from "@/lib/sequences/manage";
import { attentionEnrollments } from "@/lib/sequences/queries";
import { UserError } from "@/lib/actions";
import type { QueueItem, QueueServerHandler } from "../types";

/**
 * Today queue — sequences (NS-28 "sequence stuck"): failed and paused enrollments in MY mailbox, plus bounces from the
 * last 7 days. Task / LinkedIn steps already appear as ordinary tasks (origin "sequence"). Never throws.
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const [stuck, bounced] = await Promise.all([attentionEnrollments(user), recentBounces(user)]);
    const items: QueueItem[] = [];
    const paused = stuck.filter((e) => e.status === "paused" && e.lastError && e.systemPaused);
    // one grouped item when Gmail broke for many enrollments at once
    if (paused.length >= 3) {
      items.push({
        key: `sequence:paused:${user.id}`,
        kind: "sequence",
        title: `${paused.length} sequence emails are paused`,
        detail: paused[0]!.lastError,
        context: "Sequences",
        href: "/sequences?view=attention",
        urgency: 62,
        severity: "warning",
        actions: [
          { kind: "server", label: "Resume all", actionId: "sequences.resumeAll", payload: {}, primary: true },
          { kind: "link", label: "Reconnect Gmail", href: "/settings#connections" },
          { kind: "snooze" },
        ],
      });
    }
    for (const e of stuck) {
      if (paused.length >= 3 && paused.includes(e)) continue;
      if (e.status === "paused" && (!e.lastError || !e.systemPaused)) continue; // paused on purpose by a person
      const failed = e.status === "failed";
      items.push({
        key: `sequence:${e.id}`,
        kind: "sequence",
        title: failed ? `Sequence step failed: ${e.contactName}` : `Sequence paused: ${e.contactName}`,
        detail: e.lastError,
        context: e.sequenceName,
        href: `/sequences/${e.sequenceId}?view=attention`,
        urgency: failed ? 60 : 48,
        severity: failed ? "serious" : "warning",
        actions: [
          { kind: "server", label: failed ? "Retry" : "Resume", actionId: "sequences.retry", payload: { id: e.id }, primary: true },
          { kind: "link", label: "Open", href: `/sequences/${e.sequenceId}?view=attention` },
          { kind: "snooze" },
          { kind: "done" },
        ],
      });
    }
    for (const b of bounced)
      items.push({
        key: `sequence:bounce:${b.id}`,
        kind: "sequence",
        title: `Email bounced: ${b.contactName}`,
        detail: "The address is marked invalid. Find a new one (re-enrich) or update the contact.",
        context: b.sequenceName,
        href: `/contacts/${b.contactId}`,
        urgency: 35,
        severity: "info",
        actions: [{ kind: "link", label: "Open contact", href: `/contacts/${b.contactId}` }, { kind: "done" }],
      });
    return items.slice(0, 15);
  } catch (e) {
    console.error("[queue:sequences]", e instanceof Error ? e.message.slice(0, 160) : "error");
    return [];
  }
}

async function recentBounces(user: AppUser) {
  const visible = await contactVisibilityWhere(user);
  return db
    .select({ id: s.sequenceEnrollments.id, contactId: s.sequenceEnrollments.contactId, contactName: s.contacts.fullName, sequenceName: s.sequences.name })
    .from(s.sequenceEnrollments)
    .innerJoin(s.contacts, eq(s.contacts.id, s.sequenceEnrollments.contactId))
    .innerJoin(s.sequences, eq(s.sequences.id, s.sequenceEnrollments.sequenceId))
    .where(
      and(
        eq(s.sequenceEnrollments.senderId, user.id),
        eq(s.sequenceEnrollments.exitReason, "bounced"),
        gte(s.sequenceEnrollments.updatedAt, new Date(Date.now() - 7 * 86_400_000)),
        visible,
      ),
    )
    .orderBy(desc(s.sequenceEnrollments.updatedAt))
    .limit(5);
}

/** Server actions referenced as "sequences.<name>" by queue items (dispatched by src/lib/queue/actions.ts). */
export const actions: Record<string, QueueServerHandler> = {
  retry: async (user, payload) => {
    const id = payload.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new UserError("Enrollment not found.");
    const rows = await manageableEnrollments(user, [id]);
    const n = await setEnrollmentState(user, rows, "retry");
    if (!n) throw new UserError("This enrollment is no longer failed or paused.");
    return { message: "Back in the sequence — it runs on the next tick, inside working hours." };
  },
  // QA MAJ-12: only enrollments the SYSTEM paused; a person's deliberate pause is never lifted in bulk
  resumeAll: async (user) => {
    const { changed: n, keptManual } = await resumeSystemPaused(user);
    if (!n) return { message: keptManual ? "Nothing to resume — the paused enrollments were paused by hand." : "Nothing paused." };
    const kept = keptManual ? ` ${keptManual} paused by hand stay paused.` : "";
    return { message: `Resumed ${n} enrollment${n === 1 ? "" : "s"}. If Gmail is still disconnected they'll pause again.${kept}` };
  },
};
