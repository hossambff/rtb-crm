/** Partner share-link field allow-list and options — pure constants, safe for client components. */
export const SHARE_FIELDS = ["stage", "nextStep", "closeDate", "muu", "owner"] as const;
export type ShareField = (typeof SHARE_FIELDS)[number];

export const SHARE_FIELD_LABELS: Record<ShareField, string> = {
  stage: "Stage",
  nextStep: "Next step",
  closeDate: "Expected close",
  muu: "Audience band (MUU)",
  owner: "Owner first name",
};

/** Deal columns each share field reads — used to honor the creator's field-level security. */
export const SHARE_FIELD_SOURCES: Record<ShareField, string[]> = {
  stage: ["stageId"],
  nextStep: ["nextStep", "nextStepDueAt"],
  closeDate: ["expectedCloseDate"],
  muu: ["muu"],
  owner: ["ownerId"],
};

export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const MAX_SHARE_DEALS = 100;

