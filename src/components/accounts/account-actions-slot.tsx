import { CopilotButton } from "@/components/copilot";
import { RegisterLeadButton } from "@/components/commissions/register-lead-button";
import { EnrichButton } from "@/components/scout/enrich-button";
import { can, requireUser, scopeFor } from "@/lib/rbac/server";
import { getSetting } from "@/lib/settings";

/**
 * ACCOUNT ACTIONS SLOT — integration point for other modules on the Account 360 header (next to Edit / Merge):
 *  - Lead Scout & Enrichment (M25 / ACC-6): "Find executives" (enrichment:create)
 *  - Commissions (M18 / ACC-8): "Register lead" for users with the commission rep portal (commissions view = own)
 *  - Copilot: "Ask Copilot" with the account as context (copilot.use_ai)
 * Server component; every button is gated by its module's RBAC check (the actions re-check server-side).
 */
export type AccountActionsSlotProps = {
  account: { id: string; name: string; domain: string | null; type: string; ownerId: string | null; restricted: boolean };
  canEdit: boolean;
  /** Pipeline keys of the account's open deals (first match of NET/SPT/ENT/R100 picks the enrichment role preset). */
  openPipelineKeys?: string[];
};

const MOTIONS = ["NET", "SPT", "ENT", "R100"] as const;

export async function AccountActionsSlot({ account, openPipelineKeys = [] }: AccountActionsSlotProps) {
  const user = await requireUser();
  const [canEnrich, commissionsView, canAi, protectDays] = await Promise.all([
    can(user, "enrichment", "create"),
    scopeFor(user, "commissions", "view"),
    can(user, "copilot", "use_ai"),
    getSetting<number>("commission.registration_protect_days", 90),
  ]);
  const motion = MOTIONS.find((m) => openPipelineKeys.includes(m)) ?? "NET";
  const canRegister = commissionsView === "own" && !account.restricted;
  return (
    <>
      {canAi ? <CopilotButton context={{ accountId: account.id }} contextLabel={account.name} /> : null}
      {canEnrich && account.domain ? <EnrichButton accountId={account.id} motion={motion} label="Find executives" /> : null}
      {canRegister ? <RegisterLeadButton accountId={account.id} accountName={account.name} protectDays={Number(protectDays) || 90} /> : null}
    </>
  );
}
