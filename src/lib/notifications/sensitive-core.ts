/**
 * Pure helpers for the MNPI subject resolver (src/lib/notifications/sensitive.ts). Unit tested.
 *
 * Polymorphic `entity` / `entityId` pairs (alerts, approvals) are mapped to the record whose restriction matters.
 * Ids may carry a suffix after '#' (alert dedupe tiers such as `<invoiceId>#t7`, `<dealId>#iv:…`); the id before '#'
 * is the record.
 */

/** Entities that never describe a deal or account (org-wide counters, integrations, people, scout searches). */
export const NON_SUBJECT_ENTITIES = new Set(["org", "integration", "user", "scout_search", "scout_candidate", "alerts", "slack", "share_link", "user_prefs"]);

/** Entities the resolver can map to a deal and/or account. */
export const SUBJECT_ENTITIES = ["deal", "account", "proposal", "task", "migration", "invoice", "lead_registration", "meeting", "email_thread", "help_request", "handoff", "approval"] as const;
export type SubjectEntity = (typeof SUBJECT_ENTITIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityRef = { kind: "none" } | { kind: "subject"; entity: SubjectEntity; id: string } | { kind: "unknown" };

/**
 * Classify an entity reference:
 * - "none": nothing restricted can be behind it (no id, non-subject entity, or a non-uuid id of a non-subject entity);
 * - "subject": look up `id` (suffix stripped, lower-cased) for `entity`;
 * - "unknown": an unrecognized entity carrying a record id → callers fail closed (treat as sensitive).
 */
export function parseEntityRef(entity: string | null | undefined, entityId: string | null | undefined): EntityRef {
  if (!entity || !entityId) return { kind: "none" };
  if (NON_SUBJECT_ENTITIES.has(entity)) return { kind: "none" };
  const base = entityId.split("#")[0]!.trim();
  const known = (SUBJECT_ENTITIES as readonly string[]).includes(entity);
  if (!UUID.test(base)) return known ? { kind: "unknown" } : { kind: "none" };
  if (!known) return { kind: "unknown" };
  return { kind: "subject", entity: entity as SubjectEntity, id: base.toLowerCase() };
}
