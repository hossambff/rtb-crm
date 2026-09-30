/**
 * Client-safe DTOs for the deals module. Everything here is plain JSON (dates as ISO strings) so it can cross the
 * server → client boundary. Hidden fields (field-level security) are *absent* (undefined), never just blanked in UI.
 */
export type Priority = "top10" | "high" | "medium" | "low";
export type StageCategory = "open" | "won" | "lost" | "hold";
export type Unit = "muu" | "usd" | "activation";

export const PRIORITY_LABELS: Record<Priority, string> = { top10: "Top 10", high: "High", medium: "Medium", low: "Low" };
export const PRIORITY_ORDER: Record<string, number> = { top10: 0, high: 1, medium: 2, low: 3 };

export type StageDTO = {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  probability: number;
  category: StageCategory;
  slaDays: number | null;
  requiredFields: string[];
};

export type PipelineDTO = {
  id: string;
  key: string;
  name: string;
  type: string;
  unit: Unit;
  color: string;
  usdPerMuu: number;
  defaultRevSharePct: number | null;
  description: string | null;
};

export type UserLite = { id: string; name: string; image: string | null };

export type BoardDeal = {
  id: string;
  name: string;
  pipelineKey: string;
  stageId: string;
  status: StageCategory;
  accountId: string | null;
  accountName: string | null;
  accountDomain: string | null;
  accountCategory: string | null;
  ownerId: string | null;
  owners: (UserLite & { pct: number | null })[]; // primary owner first, then split holders
  priority: Priority | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  nextStepWaitingReason: string | null;
  overdueDays: number; // >0 when the next step is overdue
  daysInStage: number;
  stageEnteredAt: string;
  lastActivityAt: string | null;
  healthScore: number | null;
  healthExplanation: string | null;
  restricted: boolean;
  muu: number;
  grossUsd: number;
  netUsd?: number; // absent when rev share is hidden for this role
  weightedUsd: number;
  weightedMuu: number;
  probability: number;
  overridden: boolean;
  overridePending: boolean;
  contractValueCents: number | null;
  /** Gate keys that are currently filled on this deal (see gates.ts). */
  filled: string[];
  canEdit: boolean;
  createdAt: string;
};

export type BoardFilters = {
  q?: string;
  owner?: string; // user id | "me" | "none"
  priority?: Priority | "none";
  category?: string; // account category / vertical
  overdue?: boolean;
  status?: StageCategory;
};

export type Lane = "none" | "owner" | "priority";
export type BoardView = "board" | "list";

export type Picklist = { value: string; label: string }[];

export type ContactLite = { id: string; name: string; title: string | null; email: string | null };
