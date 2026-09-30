import "server-only";
/**
 * Public server API of the deals module for other modules (Copilot tools, calls, email, proposals, Nothing Slips).
 *   getDealForUser(user, id)            permission-checked deal row (hidden fields stripped) or null
 *   listDealsForBoard(user, key, f)     board/list rows with values, gates and edit flags
 *   recomputeDealHealth(dealId)         recompute + persist health (call after writing deal-related data)
 *   logActivity({...})                  insert activity + bump deals.last_activity_at / contacts.last_contacted_at
 *   loadDealForWrite(user, id, action)  assert edit/assign scope on a visible deal (throws)
 * Server actions live in ./actions ("use server"); pure helpers in ./health, ./gates, ./rules, ./summary-core.
 */
export { getDealForUser, listDealsForBoard, getDealDetail, listVisiblePipelines, pipelineOverview, assignableUsers } from "./queries";
export { recomputeDealHealth, recomputeHealthForDeals, logActivity, loadDealForWrite, hiddenDealFields, stripHidden, onDealWon, notify } from "./service";
export type { LogActivityInput } from "./service";
export { computeHealth } from "./health";
export { buildDealSummary } from "./summary";
