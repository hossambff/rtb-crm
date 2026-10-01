import "server-only";
import type { AppUser } from "@/lib/rbac/server";
import { logServerError } from "@/lib/errors";
import { getPrefs } from "@/lib/prefs";
import { atLocalTime, safeTz } from "@/lib/time";
import { confirmAllSuggestions } from "@/lib/forecast/confirm";
import { buildForecast, pendingConfirmationCount, pendingConfirmations } from "@/lib/forecast/service";
import type { QueueItem, QueueServerHandler } from "../types";

/**
 * Today queue: "Confirm your forecast (N deals)" (V2 A9). Read-only (the forecast page writes the weekly entries);
 * shown from Monday until the rep has decided every deal whose suggestion is new or disagrees with their last call.
 * Due Monday 17:00 local, so it ranks as overdue later in the week. Off when the rep turned forecast suggestions off.
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const prefs = await getPrefs(user.id);
    if (prefs.autopilot?.forecastSuggest === false) return [];
    // Perf (QA MAJ-05): one aggregate over this week's stored entries; the full build only before they exist.
    let counts = await pendingConfirmationCount(user);
    if (!counts) {
      const f = await buildForecast(user, "mine", { lite: true });
      const p = pendingConfirmations(f);
      counts = { weekOf: f.weekOf, pending: p.length, commit: p.filter((d) => d.suggested === "commit").length };
    }
    if (!counts.pending) return [];
    const f = { weekOf: counts.weekOf };
    const commit = counts.commit;
    const tz = safeTz(user.timezone);
    const due = atLocalTime(f.weekOf, 17, 0, tz);
    const n = counts.pending;
    return [
      {
        key: `forecast:${f.weekOf}`,
        kind: "forecast",
        title: `Confirm your forecast (${n} deal${n === 1 ? "" : "s"})`,
        detail: commit ? `${commit} suggested as Commit · one click accepts every suggestion` : "One click accepts every suggestion — or review and override",
        context: "Forecast",
        href: "/forecast",
        dueAt: due.toISOString(),
        urgency: 55,
        severity: "info",
        actions: [
          { kind: "server", label: `Confirm all ${n}`, actionId: "forecast.confirmAll", payload: { weekOf: f.weekOf }, confirm: `Accept the suggested category for ${n} deal${n === 1 ? "" : "s"}?`, primary: true },
          { kind: "link", label: "Review", href: "/forecast" },
          { kind: "snooze" },
        ],
      },
    ];
  } catch (e) {
    logServerError("queue.forecast", e);
    return [];
  }
}

export const actions: Record<string, QueueServerHandler> = {
  /** Accept every pending suggestion on the user's own deals (permission + reasons re-checked in confirmForecastEntries). */
  confirmAll: async (user) => {
    const r = await confirmAllSuggestions(user);
    const skipped = r.skipped.length ? ` · ${r.skipped.length} skipped` : "";
    return { message: `Forecast confirmed for ${r.confirmed} deal${r.confirmed === 1 ? "" : "s"}${skipped}` };
  },
};
