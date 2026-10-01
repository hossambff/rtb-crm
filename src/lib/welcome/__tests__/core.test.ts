import { describe, expect, it } from "vitest";
import {
  applicableSteps,
  isExemptPath,
  isLegacyUser,
  mergeTags,
  normalizeHttpsUrl,
  normalizeLinkedIn,
  onboardingStatus,
  parseStep,
  shouldRedirectToWelcome,
  wizardProgress,
  type WizardFacts,
} from "../core";

const seller: WizardFacts = { role: "ae", motionCount: 3, hasPlaceholders: true, canEmail: true, canCalls: true, slackConfigured: true };

describe("step applicability per role", () => {
  it("sellers get the full path", () => {
    expect(applicableSteps(seller)).toEqual(["welcome", "profile", "sell", "book", "targets", "tools", "work", "done"]);
  });
  it("no placeholders left → no 'Your book' step", () => {
    expect(applicableSteps({ ...seller, hasPlaceholders: false })).not.toContain("book");
  });
  it("admins and executives get the shorter path", () => {
    expect(applicableSteps({ ...seller, role: "admin" })).toEqual(["welcome", "profile", "tools", "work", "done"]);
    expect(applicableSteps({ ...seller, role: "executive" })).toEqual(["welcome", "profile", "tools", "work", "done"]);
  });
  it("finance / editorial / viewer never see selling steps; no tools step without any tool", () => {
    for (const role of ["finance", "editorial", "viewer"] as const) expect(applicableSteps({ ...seller, role })).not.toContain("sell");
    expect(applicableSteps({ ...seller, role: "viewer", canEmail: false, canCalls: false, slackConfigured: false })).toEqual(["welcome", "profile", "work", "done"]);
  });
  it("a seller role without any visible motion skips the selling steps", () => {
    expect(applicableSteps({ ...seller, role: "sdr", motionCount: 0 })).not.toContain("sell");
  });
  it("parses step params only when applicable", () => {
    const steps = applicableSteps({ ...seller, role: "admin" });
    expect(parseStep("tools", steps)).toBe("tools");
    expect(parseStep("sell", steps)).toBeNull();
    expect(parseStep("nope", steps)).toBeNull();
  });
});

describe("required-step completion", () => {
  const steps = applicableSteps(seller);
  it("blocks finishing until welcome, profile and sell are done; skips don't count", () => {
    const p = wizardProgress({ steps: { welcome: { status: "done", at: "" }, tools: { status: "skipped", at: "" } } }, steps);
    expect(p.canFinish).toBe(false);
    expect(p.missingRequired).toEqual(["profile", "sell"]);
    expect(p.done).toBe(1);
    expect(p.skipped).toEqual(["tools"]);
    expect(p.next).toBe("profile");
  });
  it("can finish with optional steps skipped; resumes at the first skipped step", () => {
    const at = "";
    const p = wizardProgress(
      {
        steps: {
          welcome: { status: "done", at },
          profile: { status: "done", at },
          sell: { status: "done", at },
          book: { status: "skipped", at },
          targets: { status: "skipped", at },
          tools: { status: "done", at },
          work: { status: "done", at },
        },
      },
      steps,
    );
    expect(p.canFinish).toBe(true);
    expect(p.next).toBe("book");
    expect(p.done).toBe(5);
  });
  it("non-sellers only need welcome + profile", () => {
    const short = applicableSteps({ ...seller, role: "finance" });
    const p = wizardProgress({ steps: { welcome: { status: "done", at: "" }, profile: { status: "done", at: "" } } }, short);
    expect(p.canFinish).toBe(true);
  });
  it("board status", () => {
    expect(onboardingStatus({})).toBe("not_started");
    expect(onboardingStatus({ startedAt: "x" })).toBe("in_progress");
    expect(onboardingStatus({ startedAt: "x", deferredAt: "y" })).toBe("deferred");
    expect(onboardingStatus({ startedAt: "x", deferredAt: "y", completedAt: "z" })).toBe("done");
  });
});

describe("first-run redirect rule", () => {
  const base = { path: "/home", state: {}, impersonating: false, createdAt: "2026-10-05T10:00:00Z", lastActiveAt: null, role: "ae" as const };
  it("sends brand-new users to /welcome", () => {
    expect(shouldRedirectToWelcome(base)).toBe(true);
    expect(shouldRedirectToWelcome({ ...base, lastActiveAt: "2026-10-05T10:05:00Z" })).toBe(true); // visited /settings first
  });
  it("never redirects once started, finished or deferred", () => {
    expect(shouldRedirectToWelcome({ ...base, state: { startedAt: "x" } })).toBe(false);
    expect(shouldRedirectToWelcome({ ...base, state: { deferredAt: "x" } })).toBe(false);
    expect(shouldRedirectToWelcome({ ...base, state: { completedAt: "x" } })).toBe(false);
  });
  it("never redirects on exempt paths or while impersonating or pending", () => {
    for (const path of ["/welcome", "/welcome/x", "/settings", "/admin/users", "/api/x"]) expect(shouldRedirectToWelcome({ ...base, path })).toBe(false);
    expect(isExemptPath("/settingsx")).toBe(false);
    expect(shouldRedirectToWelcome({ ...base, impersonating: true })).toBe(false);
    expect(shouldRedirectToWelcome({ ...base, role: "pending" })).toBe(false);
  });
  it("pre-existing users who already used the app are treated as deferred", () => {
    expect(isLegacyUser("2026-09-01T00:00:00Z", "2026-10-01T09:00:00Z")).toBe(true);
    expect(shouldRedirectToWelcome({ ...base, createdAt: "2026-09-01T00:00:00Z", lastActiveAt: "2026-09-30T09:00:00Z" })).toBe(false);
  });
  it("pre-provisioned before launch but never signed in → still onboards", () => {
    expect(shouldRedirectToWelcome({ ...base, createdAt: "2026-09-01T00:00:00Z", lastActiveAt: null })).toBe(true);
  });
});

describe("profile validation", () => {
  it("booking links must be https", () => {
    expect(normalizeHttpsUrl("calendly.com/alex/30min")).toBe("https://calendly.com/alex/30min");
    expect(normalizeHttpsUrl("http://calendly.com/alex")).toBeNull();
    expect(normalizeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHttpsUrl("https://user:pw@evil.com")).toBeNull();
    expect(normalizeHttpsUrl("localhost")).toBeNull();
  });
  it("LinkedIn links must be on linkedin.com", () => {
    expect(normalizeLinkedIn("linkedin.com/in/alex")).toBe("https://linkedin.com/in/alex");
    expect(normalizeLinkedIn("https://www.linkedin.com/in/alex")).toBe("https://www.linkedin.com/in/alex");
    expect(normalizeLinkedIn("https://notlinkedin.com/in/alex")).toBeNull();
  });
  it("merges picked tags with free text", () => {
    expect(mergeTags(["UK", "US"], "LatAm, uk ,  Nordics ")).toEqual(["UK", "US", "LatAm", "Nordics"]);
  });
});
