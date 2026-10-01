import "server-only";
import { defer } from "@/lib/defer";

/**
 * Update the Slack cards of approvals changed outside Slack (decided in the app, escalated, withdrawn, superseded),
 * after the response and outside any transaction. Never throws, never blocks the change. A no-op without Slack or
 * when no card was posted. Lazy import: the Slack approvals module depends on the approvals service.
 */
export function scheduleApprovalCardRefresh(sel: { ids?: string[]; kind?: string; entityId?: string }): void {
  if (!sel.ids?.length && !(sel.kind && sel.entityId)) return;
  defer("approval.slack_cards", async () => {
    const { refreshApprovalCards } = await import("./approvals");
    await refreshApprovalCards(sel);
  });
}
