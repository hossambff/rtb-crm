import "server-only";
import { UserError } from "@/lib/actions";
import { retryOnVersionConflict } from "./versioning-core";

/**
 * Concurrent "new version" clicks compute the same max(version)+1 and collide on proposals_deal_kind_version_uq:
 * retry once with a fresh number, then fail with a friendly message.
 */
export function withVersionRetry<T>(create: () => Promise<T>): Promise<T> {
  return retryOnVersionConflict(create, () => new UserError("Someone else just saved a version of this proposal. Refresh and try again."));
}
