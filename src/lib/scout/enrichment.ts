import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { getApifyToken } from "@/lib/apify/client";
import type { EmailFinderRecord, LinkedinEmailRecord, PersonRecord, VerifyRecord, WebsiteContactsRecord } from "@/lib/apify/mappers";
import { actorsFor } from "@/lib/apify/registry";
import { estimateCents } from "./budget-core";
import { emailMatchesName, isGenericEmail, isSeniorTitle, seniorityOf, splitName, titleMatchesRoles } from "./core";
import { suppressedEmails } from "./crm-match";
import { actorStep, loadRun, localStep, saveSteps, skipStep, stepsOf, withRunLock, type StepCtx } from "./runs";

/** Expected volumes per enrichment (for estimates; the registry maxItems caps actual runs). */
export const ENRICH_EXPECT = { websitePages: 6, people: 10, linkedinEmails: 5, patternFinder: 5, verify: 15 };

export type EnrichEstimate = { cents: number; lines: { purpose: string; actorId: string | null; results: number; costPerResultUsd: number; cents: number }[] };

export async function estimateEnrichment(): Promise<EnrichEstimate> {
  const plan: [string, number][] = [
    ["website_contacts", ENRICH_EXPECT.websitePages],
    ["people", ENRICH_EXPECT.people],
    ["email_from_linkedin", ENRICH_EXPECT.linkedinEmails],
    ["email_finder", ENRICH_EXPECT.patternFinder],
    ["email_verify", ENRICH_EXPECT.verify],
  ];
  const lines: EnrichEstimate["lines"] = [];
  for (const [purpose, results] of plan) {
    const [a] = await actorsFor(purpose as never);
    const per = a?.costPerResultUsd ?? 0;
    lines.push({ purpose, actorId: a?.actorId ?? null, results, costPerResultUsd: per, cents: a ? estimateCents(results, per) : 0 });
  }
  return { cents: lines.reduce((x, l) => x + l.cents, 0), lines };
}

export type EnrichPlan = { maxAllowedCents: number; estimateCents: number; dealId?: string | null; candidateId?: string | null; overrideApprovalId?: string | null };

type Person = { fullName: string; title: string | null; linkedinUrl: string | null; email: string | null; emailSource: string | null; sourceActor: string | null; confidence: number };

/**
 * Executive enrichment (PRD SCOUT-16..19): website contacts → people (public LinkedIn, no cookies) → email finding
 * (website > LinkedIn finder > pattern+SMTP) → verification → staging. Never sends anything (SCOUT-25).
 */
export async function runEnrichment(runId: string): Promise<void> {
  await withRunLock(runId, () => inner(runId));
}

async function inner(runId: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run || run.kind !== "enrich" || !run.accountId) return;
  if (["succeeded", "failed", "blocked"].includes(run.status)) return;
  const [account] = await db.select().from(s.accounts).where(eq(s.accounts.id, run.accountId));
  if (!account || !account.domain) {
    await saveSteps(runId, stepsOf(run), { status: "failed", error: "Account has no domain", finishedAt: new Date() });
    return;
  }
  const tokenInfo = await getApifyToken();
  if (!tokenInfo) {
    await saveSteps(runId, stepsOf(run), { status: "failed", error: "Apify is not connected", finishedAt: new Date() });
    return;
  }
  const steps = stepsOf(run);
  const plan = steps.find((x) => x.key === "plan")?.output as EnrichPlan | undefined;
  if (run.status === "queued") await saveSteps(runId, steps, { status: "running", startedAt: run.startedAt ?? new Date() });
  const ctx: StepCtx = {
    runId,
    token: tokenInfo.token,
    steps,
    remainingUsd: () => Math.max(0, (plan?.maxAllowedCents ?? 0) / 100 - ctx.steps.reduce((a, st) => a + (st.costUsd ?? 0), 0)),
  };
  const domain = account.domain;
  const roles = run.targetRoles;
  const errors: string[] = [];

  // 1) website crawl
  let site: WebsiteContactsRecord[] = [];
  try {
    const paths = ["", "/about", "/about-us", "/team", "/masthead", "/contact"];
    const r = await actorStep(ctx, "website", "Website contacts", "website_contacts", { urls: paths.map((p) => `https://${domain}${p}`), domain, domains: [domain] }, { expectedResults: ENRICH_EXPECT.websitePages });
    if (r.state === "waiting") return;
    if (r.state === "done") site = r.records;
  } catch (e) {
    errors.push(`Website: ${(e as Error).message}`);
  }
  const siteEmails = [...new Set(site.flatMap((x) => x.emails).filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`)))];
  const companyLinkedin = account.linkedinUrl ?? site.map((x) => x.companyLinkedinUrl).find(Boolean) ?? null;

  // 2) people discovery (public / no-cookie actors only — compliance enforced by the registry)
  let people: PersonRecord[] = [];
  try {
    const r = await actorStep(
      ctx,
      "people",
      "Executives (LinkedIn, public)",
      "people",
      { companyLinkedinUrls: companyLinkedin ? [companyLinkedin] : undefined, companyNames: [account.name], titles: roles, titlesJoined: roles.join(", "), domain },
      { expectedResults: ENRICH_EXPECT.people, maxItems: ENRICH_EXPECT.people },
    );
    if (r.state === "waiting") return;
    if (r.state === "done") people = r.records;
  } catch (e) {
    errors.push(`People: ${(e as Error).message}`);
  }

  const targets = (await localStep<Person[]>(ctx, "select", "Match target roles", async () => {
    const pool: Person[] = [];
    const seen = new Set<string>();
    const push = (p: Person) => {
      const k = (p.linkedinUrl ?? p.fullName).toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      pool.push(p);
    };
    for (const p of people) push({ fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, email: p.email, emailSource: p.email ? "linkedin_profile" : null, sourceActor: stepActor(ctx, "people"), confidence: 0.7 });
    for (const w of site) for (const p of w.people) push({ fullName: p.name, title: p.title, linkedinUrl: null, email: p.email, emailSource: p.email ? "website" : null, sourceActor: stepActor(ctx, "website"), confidence: 0.8 });
    let matched = pool.filter((p) => titleMatchesRoles(p.title, roles));
    if (!matched.length) matched = pool.filter((p) => isSeniorTitle(p.title));
    matched = matched.slice(0, ENRICH_EXPECT.people);
    // website emails that match a person's name
    for (const p of matched) {
      if (p.email) continue;
      const hit = siteEmails.find((e) => emailMatchesName(e, p.fullName));
      if (hit) Object.assign(p, { email: hit, emailSource: "website", confidence: 0.9 });
    }
    return { output: matched, note: `${matched.length} of ${pool.length} people match target roles` };
  })) ?? [];

  // 3) email finding — LinkedIn profile email finder, then pattern + SMTP finder
  const needLinkedin = targets.filter((p) => !p.email && p.linkedinUrl);
  if (needLinkedin.length) {
    try {
      const r = await actorStep(ctx, "email_linkedin", "Emails from LinkedIn", "email_from_linkedin", { linkedinUrls: needLinkedin.map((p) => p.linkedinUrl!), urls: needLinkedin.map((p) => p.linkedinUrl!) }, { expectedResults: needLinkedin.length, maxItems: needLinkedin.length });
      if (r.state === "waiting") return;
      if (r.state === "done") applyLinkedinEmails(targets, r.records, stepActor(ctx, "email_linkedin"));
    } catch (e) {
      errors.push(`LinkedIn email: ${(e as Error).message}`);
    }
  } else await skipStep(ctx, "email_linkedin", "Emails from LinkedIn", "Not needed");

  const needPattern = targets.filter((p) => !p.email);
  if (needPattern.length) {
    try {
      const peopleVar = needPattern.map((p) => ({ ...splitName(p.fullName), fullName: p.fullName, domain }));
      const r = await actorStep(ctx, "email_pattern", "Email pattern + SMTP", "email_finder", { people: peopleVar, domain }, { expectedResults: needPattern.length, maxItems: needPattern.length });
      if (r.state === "waiting") return;
      if (r.state === "done") applyFinderEmails(targets, r.records, stepActor(ctx, "email_pattern"));
    } catch (e) {
      errors.push(`Pattern finder: ${(e as Error).message}`);
    }
  } else await skipStep(ctx, "email_pattern", "Email pattern + SMTP", "Not needed");

  // generic inboxes useful for outreach (partnerships@, ads@, press@) — max 3
  const generic = siteEmails.filter((e) => isGenericEmail(e) && /^(partnerships?|ads|advertising|sales|press|editor|editorial)@/.test(e)).slice(0, 3);

  // 4) verification (suppressed emails never enter the pipeline)
  const allEmails = [...new Set([...targets.map((p) => p.email).filter((e): e is string => Boolean(e)), ...generic])];
  const suppressed = await suppressedEmails(allEmails);
  const toVerify = allEmails.filter((e) => !suppressed.has(e));
  let verdicts: VerifyRecord[] = [];
  if (toVerify.length) {
    try {
      const r = await actorStep(ctx, "verify", "Verify emails", "email_verify", { emails: toVerify }, { expectedResults: toVerify.length, maxItems: toVerify.length });
      if (r.state === "waiting") return;
      if (r.state === "done") verdicts = r.records;
    } catch (e) {
      errors.push(`Verify: ${(e as Error).message}`);
    }
  } else await skipStep(ctx, "verify", "Verify emails", "No emails to verify");

  // 5) staging + dedupe vs Contacts (+ optional auto-promote)
  const staged = await localStep<{ staged: number; valid: number; promoted: number }>(ctx, "stage", "Stage for review", async () => {
    const verdictBy = new Map(verdicts.map((v) => [v.email, v.verification]));
    const already = await db.select({ id: s.enrichedContacts.id }).from(s.enrichedContacts).where(eq(s.enrichedContacts.runId, runId)).limit(1);
    if (already.length) return { output: { staged: 0, valid: 0, promoted: 0 }, note: "Already staged" };
    const rows: Person[] = [
      ...targets.map((p) => (p.email && suppressed.has(p.email) ? { ...p, email: null, emailSource: null } : p)),
      ...generic.filter((e) => !suppressed.has(e)).map((e) => ({ fullName: e, title: "Generic inbox", linkedinUrl: null, email: e, emailSource: "website", sourceActor: stepActor(ctx, "website"), confidence: 0.9 })),
    ];
    if (!rows.length) return { output: { staged: 0, valid: 0, promoted: 0 }, note: "No executives found" };
    const emails = rows.map((r) => r.email).filter((e): e is string => Boolean(e));
    const links = rows.map((r) => r.linkedinUrl).filter((l): l is string => Boolean(l));
    const existing = await db
      .select({ id: s.contacts.id, email: s.contacts.email, linkedinUrl: s.contacts.linkedinUrl })
      .from(s.contacts)
      .where(and(isNull(s.contacts.deletedAt), or(emails.length ? inArray(sql`lower(${s.contacts.email})`, emails) : sql`false`, links.length ? inArray(s.contacts.linkedinUrl, links) : sql`false`)));
    const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.id]));
    const byLink = new Map(existing.filter((c) => c.linkedinUrl).map((c) => [c.linkedinUrl!, c.id]));
    const [settingRow] = await db.select().from(s.appSettings).where(eq(s.appSettings.key, "scout.auto_promote_valid_senior"));
    const autoPromote = settingRow?.value === true;
    let valid = 0;
    let promoted = 0;
    for (const p of rows) {
      const verification = p.email ? (verdictBy.get(p.email) ?? "unknown") : "unknown";
      if (verification === "valid") valid++;
      const dupId = (p.email && byEmail.get(p.email)) || (p.linkedinUrl && byLink.get(p.linkedinUrl)) || null;
      const confidence = Math.round(Math.min(1, p.confidence + (verification === "valid" ? 0.1 : verification === "invalid" ? -0.5 : 0)) * 100) / 100;
      const [ec] = await db
        .insert(s.enrichedContacts)
        .values({
          runId,
          accountId: account.id,
          fullName: p.fullName.slice(0, 200),
          title: p.title,
          seniority: seniorityOf(p.title),
          linkedinUrl: p.linkedinUrl,
          email: p.email,
          emailSource: p.emailSource,
          verification,
          confidence: Math.max(0, confidence),
          sourceActor: p.sourceActor,
          promotedContactId: dupId,
          state: dupId ? "promoted" : "staged",
        })
        .returning();
      if (!dupId && autoPromote && verification === "valid" && isSeniorTitle(p.title) && ec && run.requestedBy) {
        await promoteOne(ec, run.requestedBy, "system");
        promoted++;
      }
    }
    return { output: { staged: rows.length, valid, promoted }, note: `${rows.length} staged, ${valid} verified${promoted ? `, ${promoted} auto-promoted` : ""}` };
  });

  await saveSteps(runId, ctx.steps, {
    status: "succeeded",
    resultsCount: staged?.staged ?? 0,
    verifiedCount: staged?.valid ?? 0,
    finishedAt: new Date(),
    error: errors.length ? errors.join(" · ").slice(0, 1000) : null,
  });
}

function stepActor(ctx: StepCtx, key: string): string | null {
  return ctx.steps.find((x) => x.key === key)?.actorId || null;
}

function applyLinkedinEmails(targets: Person[], recs: LinkedinEmailRecord[], actor: string | null) {
  const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const by = new Map(recs.map((r) => [norm(r.linkedinUrl), r.email]));
  for (const p of targets) {
    if (p.email || !p.linkedinUrl) continue;
    const e = by.get(norm(p.linkedinUrl));
    if (e) Object.assign(p, { email: e, emailSource: "linkedin_finder", sourceActor: actor ?? p.sourceActor, confidence: 0.8 });
  }
}

function applyFinderEmails(targets: Person[], recs: EmailFinderRecord[], actor: string | null) {
  for (const p of targets) {
    if (p.email) continue;
    const hit = recs.find((r) => (r.fullName && r.fullName.toLowerCase() === p.fullName.toLowerCase()) || emailMatchesName(r.email, p.fullName));
    if (hit) Object.assign(p, { email: hit.email, emailSource: "pattern_smtp", sourceActor: actor ?? p.sourceActor, confidence: hit.confidence ?? 0.6 });
  }
}

/** Promote one staged row to a Contact (origin lead_scout, email status from verification). Returns contact id. */
export async function promoteOne(ec: typeof s.enrichedContacts.$inferSelect, actorId: string, actorKind: "user" | "system" = "user"): Promise<string> {
  if (ec.promotedContactId) return ec.promotedContactId;
  // dedupe again at promotion time (another run may have created it)
  const dup = await db
    .select({ id: s.contacts.id })
    .from(s.contacts)
    .where(and(isNull(s.contacts.deletedAt), or(ec.email ? eq(sql`lower(${s.contacts.email})`, ec.email.toLowerCase()) : sql`false`, ec.linkedinUrl ? eq(s.contacts.linkedinUrl, ec.linkedinUrl) : sql`false`)))
    .limit(1);
  let contactId = dup[0]?.id;
  if (!contactId) {
    const generic = ec.title === "Generic inbox";
    const { firstName, lastName } = generic ? { firstName: null, lastName: null } : splitName(ec.fullName);
    const [c] = await db
      .insert(s.contacts)
      .values({
        accountId: ec.accountId,
        firstName,
        lastName,
        fullName: ec.fullName,
        title: ec.title,
        seniority: ec.seniority,
        email: ec.email,
        emailStatus: ec.verification,
        linkedinUrl: ec.linkedinUrl,
        ownerId: actorId,
        origin: "lead_scout",
        customFields: { enrichment: { runId: ec.runId, sourceActor: ec.sourceActor, emailSource: ec.emailSource, confidence: ec.confidence, foundAt: ec.createdAt.toISOString() } },
      })
      .returning({ id: s.contacts.id });
    contactId = c!.id;
    await audit({ actorId, actorKind, action: "contact.create_from_enrichment", entity: "contact", entityId: contactId, after: { enrichedContactId: ec.id, email: ec.email, verification: ec.verification } });
  }
  await db.update(s.enrichedContacts).set({ state: "promoted", promotedContactId: contactId }).where(eq(s.enrichedContacts.id, ec.id));
  return contactId;
}
