/** Pure: how Today's Undo reverses a Done / Snooze per row kind (QA MAJ-01). Unit tested; client-safe. */

/** Undo is offered from the toast; the server accepts an alert reopen for this long after it was resolved. */
export const UNDO_WINDOW_MS = 10 * 60_000;

export type UndoPlan = "task.reopen" | "task.unsnooze" | "alert.reopen" | "queue.restore";

export function undoPlan(kind: string, from: "done" | "snooze"): UndoPlan {
  if (kind === "task") return from === "done" ? "task.reopen" : "task.unsnooze";
  if (kind === "alert") return "alert.reopen";
  return "queue.restore";
}

/**
 * Which row the keyboard may act on (QA MAJ-01): only the row that holds focus (or contains the focused control).
 * `j`/`k` from the page body only enter the queue — they never act. Returns null when nothing in the queue is focused.
 */
export function focusedRowKey(target: { closest(selector: string): { getAttribute(name: string): string | null } | null } | null): string | null {
  return target?.closest("[data-queue-row]")?.getAttribute("data-queue-row") ?? null;
}

/** A provider handler's `href` is followed only when it is a same-origin path (never "//host" or an absolute URL). */
export function safeQueueHref(href: unknown): string | null {
  return typeof href === "string" && /^\/(?!\/)[^\s\\]*$/.test(href) ? href.slice(0, 500) : null;
}
