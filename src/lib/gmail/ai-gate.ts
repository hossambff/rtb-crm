import "server-only";
import { aiAvailable } from "@/lib/ai";
import { can, loadAppUserById } from "@/lib/rbac/server";

/**
 * SEC M-6: background AI (email / transcript analysis) runs only for users whose role still has copilot.use_ai — an
 * admin override that removes AI from a role is honoured outside the app too. Inactive users (expired, banned,
 * out-of-domain) get the heuristic path. Never throws.
 */
export async function aiAllowedFor(userId: string | null | undefined): Promise<boolean> {
  if (!aiAvailable() || !userId) return false;
  try {
    const u = await loadAppUserById(userId);
    return Boolean(u) && (await can(u!, "copilot", "use_ai"));
  } catch {
    return false;
  }
}
