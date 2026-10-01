import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEntityRef, NON_SUBJECT_ENTITIES, SUBJECT_ENTITIES } from "../sensitive-core";

const U = "11ff1828-0000-4000-8000-000000000001";

describe("parseEntityRef (SEC H-2)", () => {
  it.each([
    ["deal", U, "subject"],
    ["deal", `${U}#iv:2026-01-01`, "subject"],
    ["account", U, "subject"],
    ["proposal", U, "subject"],
    ["task", U, "subject"],
    ["migration", U, "subject"],
    ["invoice", `${U}#t7`, "subject"],
    ["lead_registration", U, "subject"],
    ["meeting", U, "subject"],
    ["email_thread", U, "subject"],
    ["help_request", U, "subject"],
    ["handoff", U, "subject"],
    ["approval", U, "subject"],
    ["org", "probability_overrides", "none"],
    ["org", `apify:2026-10#t50`, "none"],
    ["integration", U, "none"],
    ["user", "abc", "none"],
    ["scout_search", U, "none"],
    ["mystery", U, "unknown"],
    ["deal", "not-a-uuid", "unknown"],
    ["somethingelse", "plain-key", "none"],
    [null, U, "none"],
    ["deal", null, "none"],
  ])("%s / %s → %s", (entity, id, kind) => {
    expect(parseEntityRef(entity, id).kind).toBe(kind);
  });

  it("strips the #suffix and lower-cases the id", () => {
    expect(parseEntityRef("invoice", `${U.toUpperCase()}#t14`)).toEqual({ kind: "subject", entity: "invoice", id: U });
  });

  it("every entity the alert engine emits is either resolvable or a known non-subject (fail-closed otherwise)", () => {
    const src = readFileSync(join(__dirname, "../../alerts/engine.ts"), "utf8");
    const emitted = new Set<string>();
    for (const m of src.matchAll(/entity:\s*(?:[^,\n]*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g)) {
      emitted.add(m[1]!);
      if (m[2]) emitted.add(m[2]);
    }
    expect(emitted.size).toBeGreaterThan(5);
    for (const e of emitted) expect((SUBJECT_ENTITIES as readonly string[]).includes(e) || NON_SUBJECT_ENTITIES.has(e), e).toBe(true);
  });
});
