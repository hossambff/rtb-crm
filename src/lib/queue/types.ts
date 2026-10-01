/**
 * Today queue contract (docs/V2_SPEC.md §B1). Pure types — safe for client components.
 * Every module that produces "things a user must act on" exports a provider: (user) => Promise<QueueItem[]>.
 * WS-A owns the aggregator/ranking/UI; each provider file under src/lib/queue/providers/ is owned by its module's team.
 *
 * Server actions ({ kind: "server" } rows): a provider file may also export
 *   `export const actions: Record<string, QueueServerHandler> = { apply: async (user, payload) => { … } }`
 * and reference it from an item with `actionId: "<provider file name>.<handler name>"`, e.g. "signals.apply".
 * The Today UI calls `runQueueAction` (src/lib/queue/actions.ts), which authenticates the user and dispatches to the
 * handler. Handlers MUST re-check permissions themselves (payload comes from the browser), audit mutations, and throw
 * `UserError` for user-facing failures. Return `{ message }` to show a toast; `{ keep: true }` keeps the row visible;
 * `{ href }` (a same-origin path) is opened after the action, e.g. a stage-move dialog that needs input.
 */
export type QueueKind =
  | "task"
  | "alert"
  | "approval"
  | "reply" // email thread awaiting our reply
  | "meeting" // meeting soon (brief ready)
  | "deal" // own open deal whose next step is missing or overdue
  | "handoff"
  | "help"
  | "signal" // deal signal from email/call
  | "forecast" // weekly forecast confirmation
  | "sequence" // sequence step needing a human (task/linkedin step, failed send)
  | "story" // share a win/loss story
  | "setup"; // first-run checklist item

export type QueueAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "done" } // generic: tasks → mark done; alerts → resolve; others → dismiss via queue_snoozes
  | { kind: "snooze" } // generic snooze menu (1h / tomorrow 9am / next Monday)
  | { kind: "delegate" } // tasks + alerts only
  | { kind: "server"; label: string; actionId: string; payload: Record<string, string>; confirm?: string; primary?: boolean };

export type QueueItem = {
  key: string; // "<kind>:<id>" — stable, used for snoozes
  kind: QueueKind;
  title: string;
  detail?: string | null;
  context?: string | null; // e.g. deal / account name
  href: string;
  dueAt?: string | null; // ISO
  /** 0..100, higher = more urgent. Providers set a base; the aggregator adjusts for due/overdue. */
  urgency: number;
  severity?: "info" | "warning" | "serious" | "critical" | null;
  actions: QueueAction[];
  /** The deal / account the row is about (optional; else parsed from `href`). Rows on soft-deleted records are dropped. */
  dealId?: string | null;
  accountId?: string | null;
  /**
   * Rows sharing a `group` (e.g. one alert rule) collapse into a single "N …" row when there are ≥ 3 of them
   * (QA MAJ-21). Set by the aggregator for alerts; providers may set it for their own repetitive rows.
   */
  group?: string | null;
};

export type QueueProvider = (user: import("@/lib/rbac/server").AppUser) => Promise<QueueItem[]>;

/** Handler for a `{ kind: "server" }` queue action (see the header comment). */
export type QueueServerHandler = (
  user: import("@/lib/rbac/server").AppUser,
  payload: Record<string, string>,
) => Promise<{ message?: string; keep?: boolean; /** Same-origin path the Today UI opens after the action (e.g. "Review move"). */ href?: string } | void>;

/** Snooze presets offered by the Today queue. */
export type SnoozePreset = "1h" | "tomorrow" | "monday";
