/**
 * Copilot shared types (client-safe: no server imports).
 * Tool outputs are plain JSON so the chat UI can render chips, suggestion cards and citations.
 */

export type CopilotContext = {
  dealId?: string;
  accountId?: string;
  meetingId?: string;
  alertId?: string;
};

export type RecordRef = { type: "deal" | "account" | "contact" | "meeting" | "task"; id: string; name: string; href: string };

export type ClaimHitView = { claimId: string; claim: string; status: "banned" | "restricted"; match: string; alternative: string | null };

export type TaskSuggestion = {
  title: string;
  description?: string | null;
  dueAt?: string | null;
  dealId?: string | null;
  dealName?: string | null;
  assigneeId: string;
  assigneeName?: string | null;
  evidence?: string | null;
};

export type StageSuggestion = {
  dealId: string;
  dealName: string;
  pipelineKey: string;
  fromStage: { key: string; name: string };
  toStage: { key: string; name: string; category: string };
  reason: string;
  gateIssues: string[];
  requiresApproval: boolean;
};

export type EmailDraft = {
  to: string;
  subject: string;
  body: string;
  dealId?: string | null;
  claims: { mode: "warn" | "block"; blocked: boolean; hits: ClaimHitView[] };
  mnpiWarnings: string[];
  contactWarnings: string[];
  engine: string;
};

/** Discriminated outputs for the tools that render as cards. */
export type CreateTaskOutput =
  | { mode: "created"; taskId: string; task: TaskSuggestion; href: string | null; note: string }
  | { mode: "suggest"; task: TaskSuggestion; note: string }
  | { mode: "refused"; error: string };

export type StageSuggestionOutput = { mode: "suggest"; suggestion: StageSuggestion; note: string } | { mode: "refused"; error: string };

export type PipelineReportRow = {
  group: string;
  deals: number;
  muu: number;
  valueUsd: number;
  weightedUsd: number;
  liveActivations: number;
};

export type PipelineReport = {
  basis: "gross" | "net";
  basisLabel: string;
  groupBy: "stage" | "owner" | "category";
  pipelineKey: string | null;
  status: "open" | "all";
  includeOverrides: boolean;
  overrideDeals: number;
  rows: PipelineReportRow[];
  totals: PipelineReportRow;
  notes: string[];
};

export type MeetingBrief = {
  meetingId: string | null;
  dealId: string | null;
  title: string;
  startsAt: string | null;
  attendees: { email: string; name: string | null; title: string | null; role: string | null }[];
  history: { date: string; type: string; summary: string }[];
  openItems: { title: string; owedBy: string | null; dueAt: string | null }[];
  agenda: string[];
  proofPoints: { text: string; evidence: string | null }[];
  objections: { id: string; objection: string; rebuttal: string }[];
  markdown: string;
  stored: boolean;
  engine: "heuristic";
};

export const COPILOT_TOOL_LABELS: Record<string, { running: string; done: string }> = {
  search_records: { running: "Searching records", done: "Searched records" },
  find_deals: { running: "Filtering deals", done: "Filtered deals" },
  get_deal: { running: "Opening deal", done: "Read deal" },
  get_account: { running: "Opening account", done: "Read account" },
  get_timeline: { running: "Reading timeline", done: "Read timeline" },
  list_my_work: { running: "Checking your work", done: "Checked your work" },
  pipeline_report: { running: "Building pipeline report", done: "Built pipeline report" },
  create_task: { running: "Preparing task", done: "Task" },
  suggest_stage_change: { running: "Checking stage gates", done: "Stage suggestion" },
  draft_email: { running: "Drafting email", done: "Drafted email" },
  check_claims: { running: "Checking claims", done: "Checked claims" },
  meeting_prep: { running: "Preparing meeting brief", done: "Meeting brief" },
  web_research: { running: "Researching the web", done: "Web research" },
};
