/**
 * ACCOUNT ACTIONS SLOT — integration point for other modules.
 *
 * The Account 360 header renders <AccountActionsSlot/> next to Edit / Merge. Modules plug in here:
 *  - Lead Scout & Enrichment (M25): "Enrich" / "Find executives" button (ACC-6, SCOUT enrichment runs)
 *  - Commissions (M18 / ACC-8): "Register lead" button for commission reps
 * Add your component below (server or client), gated by your module's RBAC check. Currently renders nothing.
 */
export type AccountActionsSlotProps = {
  account: { id: string; name: string; domain: string | null; type: string; ownerId: string | null; restricted: boolean };
  canEdit: boolean;
};

export function AccountActionsSlot(props: AccountActionsSlotProps) {
  void props;
  return null;
}
