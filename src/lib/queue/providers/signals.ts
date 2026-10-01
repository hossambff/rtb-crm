import "server-only";
import { logServerError } from "@/lib/errors";
import { getPrefs } from "@/lib/prefs";
import { formatInTz } from "@/lib/time";
import type { AppUser } from "@/lib/rbac/server";
import { applyLabel, applyMode, moveDialogHref, SIGNAL_LABELS, signalUrgency } from "@/lib/signals/core";
import { pendingSignalsForOwner } from "@/lib/signals/queries";
import { applySignal, dismissSignal } from "@/lib/signals/service";
import type { QueueItem, QueueServerHandler } from "../types";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Today queue: pending deal signals on the user's own deals (V2 A4) — one row per signal with Apply (gated stage move /
 * close date / follow-up task) and Dismiss. Off when the user turned email signals off.
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const prefs = await getPrefs(user.id);
    if (prefs.autopilot?.emailSignals === false) return [];
    const signals = await pendingSignalsForOwner(user, 12);
    return signals.map((sig) => {
      const label = applyLabel(sig.kind, sig.suggestedStageName, sig.suggestedCloseDate ? new Date(sig.suggestedCloseDate) : null, (d) => formatInTz(d, user.timezone, "date"));
      return {
        key: `signal:${sig.id}`,
        kind: "signal",
        title: `${SIGNAL_LABELS[sig.kind]}: ${sig.dealName}`,
        detail: sig.quote ? `“${sig.quote.slice(0, 160)}” — from ${sig.source === "email" ? "an email" : "a call"}` : sig.rationale,
        context: sig.dealName,
        href: `/deals/${sig.dealId}`,
        dueAt: null,
        urgency: signalUrgency(sig.kind, sig.confidence ?? 0.5),
        severity: sig.kind === "lost" || sig.kind === "risk" ? "warning" : "info",
        actions: [
          { kind: "server", label, actionId: "signals.apply", payload: { id: sig.id }, primary: true, ...(sig.kind === "lost" || sig.kind === "won" ? { confirm: `${label}?` } : {}) },
          { kind: "server", label: "Dismiss", actionId: "signals.dismiss", payload: { id: sig.id } },
          // CR M9: a stage move can always be finished in the deal's (prefilled) move dialog
          ...(applyMode(sig.kind, sig.suggestedStageId) === "stage" && sig.suggestedStageId ? [{ kind: "link" as const, label: "Review move", href: moveDialogHref(sig.dealId, sig.suggestedStageId, sig.id) }] : []),
          ...(sig.sourceHref ? [{ kind: "link" as const, label: sig.source === "email" ? "Open email" : "Open call", href: sig.sourceHref }] : []),
          { kind: "snooze" },
        ],
      } satisfies QueueItem;
    });
  } catch (e) {
    logServerError("queue.signals", e);
    return [];
  }
}

export const actions: Record<string, QueueServerHandler> = {
  /** applySignal re-checks deal edit permission, gates and approvals; throws UserError for the toast. */
  apply: async (user, payload) => {
    if (!UUID.test(payload.id ?? "")) return { message: "Signal not found." };
    const r = await applySignal(user, payload.id!);
    // needs input → keep the row and take the user straight to the prefilled stage-move dialog
    return r.status === "needs_input" ? { message: r.message, keep: true, href: r.href } : { message: r.message };
  },
  dismiss: async (user, payload) => {
    if (!UUID.test(payload.id ?? "")) return { message: "Signal not found." };
    await dismissSignal(user, payload.id!);
    return { message: "Signal dismissed." };
  },
};
