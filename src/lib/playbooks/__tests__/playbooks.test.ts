import { describe, expect, it } from "vitest";
import { businessDateInput, fillTemplate, firstStep, playbookDueAt, playbookInputSchema, playbookSource, resolveAssignee, tasksToCreate } from "../core";
import { DEFAULT_PLAYBOOKS } from "../defaults";

const now = new Date("2026-10-02T14:00:00Z"); // Friday

describe("stage playbooks", () => {
  it("creates only tasks not yet on the deal for this stage (idempotent re-entry)", () => {
    const tpl = [
      { title: "Send recap", dueInDays: 1, assignTo: "owner" as const },
      { title: "Book demo", dueInDays: 3, assignTo: "owner" as const },
      { title: "  send   RECAP ", dueInDays: 2, assignTo: "manager" as const },
    ];
    expect(tasksToCreate(tpl, []).map((t) => t.title)).toEqual(["Send recap", "Book demo"]);
    expect(tasksToCreate(tpl, ["send recap", "Book demo"])).toEqual([]);
    expect(playbookSource("abc")).toBe("playbook:abc");
  });

  it("resolves assignees with owner / actor fallbacks", () => {
    const ctx = { ownerId: "o", managerId: "m", onboardingId: "ob", actorId: "a" };
    expect(resolveAssignee("owner", ctx)).toBe("o");
    expect(resolveAssignee("manager", ctx)).toBe("m");
    expect(resolveAssignee("onboarding", ctx)).toBe("ob");
    expect(resolveAssignee("manager", { ...ctx, managerId: null })).toBe("o");
    expect(resolveAssignee("onboarding", { ...ctx, onboardingId: null, ownerId: null })).toBe("a");
  });

  it("due dates count business days and land at 17:00 local", () => {
    const due = playbookDueAt(now, 1, "America/New_York"); // Fri → Mon
    expect(due.toISOString()).toBe("2026-10-05T21:00:00.000Z");
    expect(businessDateInput(now, 0, "America/New_York")).toBe("2026-10-02");
    expect(businessDateInput(now, 3, "America/New_York")).toBe("2026-10-07");
  });

  it("first step prefers the first owner task", () => {
    expect(firstStep([{ title: "Kickoff", dueInDays: 3, assignTo: "onboarding" }, { title: "Intro", dueInDays: 1, assignTo: "owner" }])).toEqual({ title: "Intro", dueInDays: 1 });
    expect(firstStep([])).toBeNull();
  });

  it("fills template variables and leaves unknown tokens visible", () => {
    expect(fillTemplate("Hi {{first_name}}, {{ company }} — {{nope}}", { first_name: "Ann", company: "Acme" })).toBe("Hi Ann, Acme — {{nope}}");
  });

  it("every default playbook validates against the admin schema", () => {
    let n = 0;
    for (const [pipe, stages] of Object.entries(DEFAULT_PLAYBOOKS)) {
      for (const [key, pb] of Object.entries(stages)) {
        const r = playbookInputSchema.safeParse({ stageId: "00000000-0000-4000-8000-000000000000", name: pb.name, guidance: pb.guidance, tasks: pb.tasks, emailTemplates: pb.emailTemplates ?? [], active: true });
        expect(r.success, `${pipe}/${key}`).toBe(true);
        n++;
      }
    }
    expect(Object.keys(DEFAULT_PLAYBOOKS).sort()).toEqual(["ADS", "ENT", "NET", "R100", "SPT"]);
    expect(n).toBeGreaterThan(30);
  });
});
