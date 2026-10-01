"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { CheckCircle2, Command, MessageSquare, Sparkles, Sun } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { ModKey } from "@/components/ui/mod-key";
import { GoogleConnection } from "@/components/settings/google-connection";
import { GranolaForm } from "@/components/settings/granola-form";
import { cn } from "@/lib/utils";
import { POST_CALL_LABELS } from "@/lib/prefs/core";
import { LANGUAGE_OPTIONS, REGION_OPTIONS, STEP_META, type StepStatus, type WizardStepId } from "@/lib/welcome/core";
import { formatTarget, fromStoredTarget, METRIC_LABELS, metricsForMotion, periodLabel, type QuotaMetric } from "@/lib/quotas/core";
import {
  finishOnboarding,
  markWizardStep,
  proposeTargets,
  reportProfileIssue,
  requestPlaceholderClaim,
  saveProfileStep,
  saveSellStep,
  saveSlackStep,
  saveWorkStep,
} from "@/lib/welcome/actions";
import type { WizardData } from "@/lib/welcome/queries";
import { Chip, Field, Segmented, STEP_FORM_ID, StepFooter, Switch } from "./bits";

export type StepProps = {
  onBack?: () => void;
  onComplete: (status: StepStatus) => void;
  status: StepStatus | null;
};

type Result = { ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** Run a server action; toast its error; return success. */
async function run(r: Promise<Result>, setErrors?: (e: Record<string, string[]>) => void): Promise<boolean> {
  const res = await r;
  if (!res.ok) {
    setErrors?.(res.fieldErrors ?? {});
    toast.error(res.error);
    return false;
  }
  setErrors?.({});
  return true;
}

function useSkip(step: WizardStepId, onComplete: StepProps["onComplete"]) {
  const [pending, start] = useTransition();
  const skip = () =>
    start(async () => {
      if (await run(markWizardStep({ step, status: "skipped" }))) onComplete("skipped");
    });
  return { skipping: pending, skip };
}

/* ───────────── a. Welcome ───────────── */

const EMPLOYMENT_LABELS: Record<string, string> = { staff: "Staff", retainer: "Retainer", hourly: "Hourly", commission: "Commission", contractor: "Contractor" };

export function WelcomeStep({ who, status, onComplete }: StepProps & { who: WizardData["who"] }) {
  const [ack, setAck] = useState(status === "done");
  const [reporting, setReporting] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const rows: [string, string | null][] = [
    ["Role", who.roleLabel],
    ["Team", who.team],
    ["Manager", who.manager],
    ["Employment", EMPLOYMENT_LABELS[who.employmentType] ?? who.employmentType],
  ];
  return (
    <form
      id={STEP_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ack) return void toast.error("Confirm the details above first.");
        start(async () => {
          if (await run(markWizardStep({ step: "welcome", status: "done" }))) onComplete("done");
        });
      }}
    >
      <p className="text-sm text-body">
        This takes about five minutes. Everything except your profile can wait — skip what you like and it stays on your My Day checklist.
      </p>
      <dl className="mt-6 divide-y divide-border rounded-lg border border-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-muted">{k}</dt>
            <dd className={cn("text-right text-sm", v ? "text-fg" : "text-muted")}>{v ?? "Not set yet"}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted">Set by your admin. Signed in as {who.email}.</p>

      <label className="mt-6 flex cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 hover:bg-surface-1">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="size-4 accent-white" />
        <span className="text-sm text-fg">That&apos;s me — looks right.</span>
      </label>

      <div className="mt-4">
        {sent ? (
          <p className="text-xs text-muted" role="status">
            Sent. An admin will fix it — you can carry on meanwhile.
          </p>
        ) : reporting ? (
          <div className="space-y-2">
            <label htmlFor="w-issue" className="text-xs font-medium text-secondary">
              What looks wrong?
            </label>
            <Textarea id="w-issue" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. I report to Sam, and I'm on the ENT team." />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending || message.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    const r = await reportProfileIssue({ message });
                    if (!r.ok) return void toast.error(r.error);
                    setSent(true);
                    toast.success("Admins notified.");
                  })
                }
              >
                Tell an admin
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setReporting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="text-xs text-secondary underline underline-offset-4 hover:text-fg" onClick={() => setReporting(true)}>
            Something&apos;s wrong? Tell an admin
          </button>
        )}
      </div>
      <StepFooter pending={pending} continueDisabled={!ack} required continueLabel="Let's go" />
    </form>
  );
}

/* ───────────── b. Profile ───────────── */

const COMMON_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Lisbon", "Europe/Paris", "Asia/Dubai", "Africa/Cairo", "Asia/Singapore", "UTC"];
const zoneLabel = (z: string) => z.replace(/_/g, " ");
const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function ProfileStep({ profile, zones, onBack, onComplete }: StepProps & { profile: WizardData["profile"]; zones: string[] }) {
  const [f, setF] = useState({
    title: profile.title,
    phone: profile.phone,
    linkedinUrl: profile.linkedinUrl,
    bookingUrl: profile.bookingUrl,
    timezone: profile.timezone,
    workStartHour: profile.workStartHour,
    workEndHour: profile.workEndHour,
    signature: profile.signature,
  });
  const [detected, setDetected] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  useEffect(() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!z || !zones.includes(z)) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only value, read once after hydration
      setDetected(z);
      // Smart default: until the person confirms a zone, the device's zone wins over the server default.
      if (!profile.timezoneConfirmed) setF((p) => ({ ...p, timezone: z }));
    } catch {
      /* no Intl zone */
    }
  }, [zones, profile.timezoneConfirmed]);
  const common = COMMON_ZONES.filter((z) => zones.includes(z));
  const err = (k: string) => errors[k]?.[0];

  return (
    <form
      id={STEP_FORM_ID}
      className="grid gap-5 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          if (await run(saveProfileStep(f), setErrors)) onComplete("done");
        });
      }}
    >
      <Field label="Title" htmlFor="w-title" error={err("title")}>
        <Input id="w-title" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Account Executive, Sports" autoComplete="organization-title" />
      </Field>
      <Field label="Phone" htmlFor="w-phone" error={err("phone")} hint="Optional — shown in your signature.">
        <Input id="w-phone" type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+44 20 7946 0000" autoComplete="tel" />
      </Field>
      <Field label="LinkedIn" htmlFor="w-li" error={err("linkedinUrl")}>
        <Input id="w-li" inputMode="url" value={f.linkedinUrl} onChange={(e) => set("linkedinUrl", e.target.value)} placeholder="linkedin.com/in/you" />
      </Field>
      <Field label="Booking link" htmlFor="w-book" error={err("bookingUrl")} hint="Calendly or a Google booking page — used as {{booking_link}} in sequences.">
        <Input id="w-book" inputMode="url" value={f.bookingUrl} onChange={(e) => set("bookingUrl", e.target.value)} placeholder="https://calendly.com/you/30min" />
      </Field>

      <Field
        label="Time zone"
        htmlFor="w-tz"
        error={err("timezone")}
        hint={
          detected && detected === f.timezone && !profile.timezoneConfirmed ? (
            "Detected from this device."
          ) : detected && detected !== f.timezone ? (
            <button type="button" className="text-fg underline underline-offset-2" onClick={() => set("timezone", detected)}>
              Use this device&apos;s zone ({zoneLabel(detected)})
            </button>
          ) : (
            "Drives quiet hours, SLA timers and your My Day."
          )
        }
      >
        <NativeSelect id="w-tz" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} required>
          <optgroup label="Common">
            {common.map((z) => (
              <option key={`c-${z}`} value={z}>
                {zoneLabel(z)}
              </option>
            ))}
          </optgroup>
          <optgroup label="All time zones">
            {zones
              .filter((z) => !common.includes(z))
              .map((z) => (
                <option key={z} value={z}>
                  {zoneLabel(z)}
                </option>
              ))}
          </optgroup>
        </NativeSelect>
      </Field>
      <Field label="Working hours" error={err("workEndHour")} hint="Nothing pings you outside these hours unless it's critical.">
        <div className="flex items-center gap-2">
          <NativeSelect aria-label="Start of working day" value={f.workStartHour} onChange={(e) => set("workStartHour", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </NativeSelect>
          <span className="text-muted">to</span>
          <NativeSelect aria-label="End of working day" value={f.workEndHour} onChange={(e) => set("workEndHour", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </Field>
      <Field label="Email signature" htmlFor="w-sig" className="sm:col-span-2" hint="Appended to emails you send and drafts Copilot writes for you.">
        <Textarea id="w-sig" rows={4} value={f.signature} onChange={(e) => set("signature", e.target.value)} placeholder={"Alex Morgan\nAccount Executive · Roundtable"} />
      </Field>
      <div className="sm:col-span-2">
        <StepFooter onBack={onBack} pending={pending} required />
      </div>
    </form>
  );
}

/* ───────────── c. What you sell ───────────── */

function TagPicker({ label, options, value, onChange, other, onOther, otherId }: { label: string; options: readonly string[]; value: string[]; onChange: (v: string[]) => void; other: string; onOther: (v: string) => void; otherId: string }) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o} pressed={value.includes(o)} onToggle={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>
            {o}
          </Chip>
        ))}
      </div>
      <Input id={otherId} aria-label={`Other ${label.toLowerCase()}`} className="mt-2" value={other} onChange={(e) => onOther(e.target.value)} placeholder="Others, comma separated" />
    </Field>
  );
}

export function SellStep({ sell, onBack, onComplete }: StepProps & { sell: WizardData["sell"] }) {
  const [keys, setKeys] = useState<string[]>(sell.selected);
  const [regions, setRegions] = useState(sell.regions.filter((r) => (REGION_OPTIONS as readonly string[]).includes(r)));
  const [regionsOther, setRegionsOther] = useState(sell.regions.filter((r) => !(REGION_OPTIONS as readonly string[]).includes(r)).join(", "));
  const [languages, setLanguages] = useState(sell.languages.filter((r) => (LANGUAGE_OPTIONS as readonly string[]).includes(r)));
  const [languagesOther, setLanguagesOther] = useState(sell.languages.filter((r) => !(LANGUAGE_OPTIONS as readonly string[]).includes(r)).join(", "));
  const [focus, setFocus] = useState(sell.focus);
  const [pending, start] = useTransition();
  return (
    <form
      id={STEP_FORM_ID}
      className="space-y-7"
      onSubmit={(e) => {
        e.preventDefault();
        if (!keys.length) return void toast.error("Pick at least one motion you sell.");
        start(async () => {
          if (await run(saveSellStep({ pipelineKeys: keys, regions, regionsOther, languages, languagesOther, focus }))) onComplete("done");
        });
      }}
    >
      <Field label="Motions you sell" hint="Pipelines, pickers and your Today list lead with these. You can still open the others.">
        <div className="flex flex-wrap gap-2">
          {sell.motions.map((m) => (
            <Chip key={m.key} pressed={keys.includes(m.key)} onToggle={() => setKeys((k) => (k.includes(m.key) ? k.filter((x) => x !== m.key) : [...k, m.key]))}>
              {!keys.includes(m.key) ? <ColorTick color={m.color} /> : null}
              {m.name}
            </Chip>
          ))}
        </div>
      </Field>
      <TagPicker label="Regions & markets" options={REGION_OPTIONS} value={regions} onChange={setRegions} other={regionsOther} onOther={setRegionsOther} otherId="w-regions" />
      <TagPicker label="Languages you sell in" options={LANGUAGE_OPTIONS} value={languages} onChange={setLanguages} other={languagesOther} onOther={setLanguagesOther} otherId="w-langs" />
      <Field label="Focus" htmlFor="w-focus" hint="One line your leader and Copilot can use, e.g. “Tier-1 sports publishers in the Gulf”.">
        <Textarea id="w-focus" rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} />
      </Field>
      <StepFooter onBack={onBack} pending={pending} required continueDisabled={!keys.length} />
    </form>
  );
}

/* ───────────── d. Your book ───────────── */

const plural = (n: number, w: string) => `${new Intl.NumberFormat("en-US").format(n)} ${w}${n === 1 ? "" : "s"}`;

export function BookStep({ book, onBack, onComplete }: StepProps & { book: WizardData["book"] }) {
  const [claims, setClaims] = useState(book.claims);
  const [pending, start] = useTransition();
  const { skip, skipping } = useSkip("book", onComplete);
  const latest = useMemo(() => {
    const m = new Map<string, (typeof claims)[number]>();
    for (const c of claims) if (!m.has(c.placeholderId)) m.set(c.placeholderId, c);
    return m;
  }, [claims]);
  const asked = claims.some((c) => c.status === "pending" || c.status === "approved");
  return (
    <form
      id={STEP_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          if (await run(markWizardStep({ step: "book", status: "done" }))) onComplete("done");
        });
      }}
    >
      <p className="text-sm text-body">
        Deals from the old spreadsheets were imported under placeholder names. If one of these is you, say so — an admin confirms and everything
        it owns (deals, accounts, tasks) moves to you.
      </p>
      {book.placeholders.length ? (
        <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
          {book.placeholders.map((p) => {
            const c = latest.get(p.id);
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">{p.name}</p>
                  <p className="text-xs text-muted tabular">
                    {[plural(p.deals, "deal"), p.accounts ? plural(p.accounts, "account") : null, p.tasks ? plural(p.tasks, "open task") : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {c?.status === "pending" ? (
                  <StatusBadge status="progress" label="With an admin" />
                ) : c?.status === "approved" ? (
                  <StatusBadge status="good" label="Yours" />
                ) : (
                  <div className="flex items-center gap-2">
                    {c?.status === "rejected" ? <StatusBadge status="warning" label="Declined" /> : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const r = await requestPlaceholderClaim({ placeholderId: p.id });
                          if (!r.ok) return void toast.error(r.error);
                          setClaims((cs) => [{ id: r.data.id, placeholderId: p.id, placeholderName: p.name, status: "pending", note: null, createdAt: new Date().toISOString() }, ...cs]);
                          toast.success("Sent to an admin. You'll get a notification when it's done.");
                        })
                      }
                    >
                      These are mine
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">Every imported placeholder has been claimed.</p>
      )}
      {claims.some((c) => c.status === "rejected" && c.note) ? (
        <p className="mt-3 text-xs text-muted">Declined requests carry the admin&apos;s reason in your notifications.</p>
      ) : null}
      <StepFooter onBack={onBack} onSkip={skip} pending={pending || skipping} continueLabel={asked ? "Continue" : "None of these are mine"} />
    </form>
  );
}

/* ───────────── e. Targets ───────────── */

type QuotaView = WizardData["targets"]["quotas"][number];
type Line = { pipelineKey: string; metric: QuotaMetric };

export function TargetsStep({ targets, motions, onBack, onComplete }: StepProps & { targets: WizardData["targets"]; motions: WizardData["sell"]["motions"] }) {
  const periods = [targets.current, targets.next];
  const name = (k: string) => (k ? (motions.find((m) => m.key === k)?.name ?? k) : "All motions");
  const color = (k: string) => motions.find((m) => m.key === k)?.color;
  // Lines per period: leader-set and proposed quotas, plus the default lines nobody has a number for yet.
  const linesFor = (period: string): Line[] => {
    const have = targets.quotas.filter((q) => q.period === period).map((q) => ({ pipelineKey: q.pipelineKey, metric: q.metric }));
    const extra = targets.lines.filter((l) => !have.some((h) => h.pipelineKey === l.pipelineKey));
    return [...have, ...extra];
  };
  const find = (period: string, l: Line): QuotaView | undefined => targets.quotas.find((q) => q.period === period && q.pipelineKey === l.pipelineKey && q.metric === l.metric);
  const [values, setValues] = useState<Record<string, { metric: QuotaMetric; value: string }>>(() => {
    const v: Record<string, { metric: QuotaMetric; value: string }> = {};
    for (const p of periods)
      for (const l of linesFor(p)) {
        const q = find(p, l);
        v[`${p}|${l.pipelineKey}|${l.metric}`] = { metric: l.metric, value: q && q.status === "proposed" ? String(fromStoredTarget(q.metric, q.target)) : "" };
      }
    return v;
  });
  const [pending, start] = useTransition();
  const { skip, skipping } = useSkip("targets", onComplete);
  const anySet = targets.quotas.some((q) => q.status === "set");

  return (
    <form
      id={STEP_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          let proposed = 0;
          for (const p of periods) {
            const lines = Object.entries(values)
              .filter(([k, v]) => k.startsWith(`${p}|`) && Number(v.value) > 0)
              .map(([k, v]) => ({ pipelineKey: k.split("|")[1]!, metric: v.metric, target: Number(v.value) }));
            if (!lines.length) continue;
            const r = await proposeTargets({ period: p, lines });
            if (!r.ok) return void toast.error(r.error);
            proposed += r.data.saved;
          }
          if (!proposed && !anySet) return void toast.error("Enter at least one target, or skip for now.");
          if (!proposed && !(await run(markWizardStep({ step: "targets", status: "done" })))) return;
          if (proposed) toast.success("Proposed — your leader will confirm in Team setup.");
          onComplete("done");
        });
      }}
    >
      <p className="text-sm text-body">
        {anySet ? "Your leader has set targets. " : "No targets yet — propose what you think is right; your leader confirms or adjusts. "}
        Revenue in US dollars, audiences in monthly unique users.
      </p>
      <div className="mt-6 space-y-6">
        {periods.map((p) => (
          <section key={p} aria-labelledby={`q-${p}`}>
            <h3 id={`q-${p}`} className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              {periodLabel(p)} {p === targets.current ? "· this quarter" : "· next quarter"}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {linesFor(p).map((l) => {
                const key = `${p}|${l.pipelineKey}|${l.metric}`;
                const q = find(p, l);
                const v = values[key] ?? { metric: l.metric, value: "" };
                const c = color(l.pipelineKey);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <span className="flex min-w-28 items-center gap-2 text-sm text-fg">
                      {c ? <ColorTick color={c} /> : null}
                      {name(l.pipelineKey)}
                    </span>
                    {q?.status === "set" ? (
                      <span className="ml-auto flex items-center gap-2">
                        <span className="font-display text-lg text-fg tabular">{formatTarget(q.metric, q.target)}</span>
                        <StatusBadge status="good" label="Set by your leader" />
                      </span>
                    ) : (
                      <span className="ml-auto flex items-center gap-2">
                        <NativeSelect
                          aria-label={`${name(l.pipelineKey)} metric, ${periodLabel(p)}`}
                          className="h-8 w-40"
                          value={v.metric}
                          onChange={(e) => setValues((s) => ({ ...s, [key]: { ...v, metric: e.target.value as QuotaMetric } }))}
                        >
                          {metricsForMotion(l.pipelineKey).map((m) => (
                            <option key={m} value={m}>
                              {METRIC_LABELS[m]}
                            </option>
                          ))}
                        </NativeSelect>
                        <span className="relative">
                          {v.metric === "revenue_usd" ? <span className="pointer-events-none absolute left-2.5 top-1.5 text-sm text-muted">$</span> : null}
                          <Input
                            aria-label={`${name(l.pipelineKey)} target, ${periodLabel(p)}`}
                            inputMode="numeric"
                            className={cn("h-8 w-32 text-right tabular", v.metric === "revenue_usd" && "pl-6")}
                            value={v.value}
                            onChange={(e) => setValues((s) => ({ ...s, [key]: { ...v, value: e.target.value.replace(/[^\d.]/g, "") } }))}
                            placeholder="0"
                          />
                        </span>
                        {q?.status === "proposed" ? <StatusBadge status="progress" label="Proposed" /> : null}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <StepFooter onBack={onBack} onSkip={skip} pending={pending || skipping} />
    </form>
  );
}

/* ───────────── f. Tools ───────────── */

/** One tool: the existing connect component (it carries its own title and live status) + why it's worth it. */
function ToolBlock({ why, connected, children }: { why: string; connected: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("rounded-lg border transition-colors duration-200", connected ? "border-border-strong" : "border-border")}>
      <div className="px-4 py-4">{children}</div>
      <p className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted">
        {connected ? <CheckCircle2 className="size-3.5 shrink-0 text-good" aria-hidden /> : <span className="shrink-0 text-secondary">Why</span>}
        {why}
      </p>
    </section>
  );
}

export function ToolsStep({ tools, scopes, onBack, onComplete }: StepProps & { tools: WizardData["tools"]; scopes: string[] }) {
  const [slackDm, setSlackDm] = useState(tools.slackDm);
  const [slackId, setSlackId] = useState(tools.slackUserId ?? "");
  const [slackSaved, setSlackSaved] = useState(tools.slackDm && Boolean(tools.slackUserId));
  const [slackErr, setSlackErr] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const { skip, skipping } = useSkip("tools", onComplete);
  const google = tools.google.gmailRead && tools.google.calendar;
  const granola = Boolean(tools.granola && tools.granola.status !== "revoked" && tools.granola.masked);
  const any = google || granola || slackSaved;
  return (
    <div>
      <p className="text-sm text-body">Each one is optional. Connect what you use now; the rest stays on your checklist.</p>
      <div className="mt-6 space-y-4">
        {tools.canEmail ? (
          <ToolBlock why="Replies, promises and meetings land on the right deal by themselves — no logging." connected={google}>
            <GoogleConnection state={tools.google} scopes={scopes} required={tools.mailboxRequired} returnTo="/welcome?step=tools" backTo="/welcome?step=tools" />
          </ToolBlock>
        ) : null}
        {tools.canCalls ? (
          <ToolBlock why="Calls become notes, tasks and a drafted follow-up you approve." connected={granola}>
            <GranolaForm conn={tools.granola} />
          </ToolBlock>
        ) : null}
        {tools.slackConfigured ? (
          <ToolBlock why="Only what matters pings you in Slack; approvals become one-click buttons." connected={slackSaved}>
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  <MessageSquare className="size-4 text-muted" aria-hidden /> Slack
                </p>
                {slackSaved ? <StatusBadge status="good" label="DMs on" /> : <StatusBadge status="info" label="Off" />}
              </div>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="w-slackdm" className="text-sm text-body">
                  DM me in Slack
                </label>
                <Switch id="w-slackdm" label="DM me in Slack" checked={slackDm} onChange={setSlackDm} />
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Slack member ID" htmlFor="w-slackid" error={slackErr} hint="Slack → your profile → ⋯ → Copy member ID. Optional: we try your email first." className="min-w-56 flex-1">
                  <Input id="w-slackid" value={slackId} onChange={(e) => setSlackId(e.target.value.toUpperCase())} placeholder="U0123ABCD" spellCheck={false} autoComplete="off" />
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mb-5 h-9"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await saveSlackStep({ slackDm, slackUserId: slackId });
                      if (!r.ok) {
                        setSlackErr(r.fieldErrors?.slackUserId?.[0] ?? r.error);
                        return;
                      }
                      setSlackErr(undefined);
                      setSlackSaved(r.data.slackDm);
                      toast.success(r.data.slackDm ? "Slack DMs on." : "Saved.");
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          </ToolBlock>
        ) : null}
      </div>
      <form
        id={STEP_FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            if (await run(markWizardStep({ step: "tools", status: "done" }))) onComplete("done");
          });
        }}
      />
      <StepFooter onBack={onBack} onSkip={skip} pending={pending || skipping} continueDisabled={!any} />
    </div>
  );
}

/* ───────────── g. How you work ───────────── */

export function WorkStep({ work, onBack, onComplete }: StepProps & { work: WizardData["work"] }) {
  const [budget, setBudget] = useState(work.alertBudgetPerDay);
  const [postCall, setPostCall] = useState<"off" | "review" | "auto">(work.postCall);
  const [briefs, setBriefs] = useState(work.meetingBriefs);
  const [pending, start] = useTransition();
  const { skip, skipping } = useSkip("work", onComplete);
  return (
    <form
      id={STEP_FORM_ID}
      className="space-y-8"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          if (await run(saveWorkStep({ alertBudgetPerDay: budget, postCall, meetingBriefs: briefs }))) onComplete("done");
        });
      }}
    >
      <Field label="Interruptions a day" htmlFor="w-budget" hint="Beyond this, alerts wait for your daily digest. Critical ones always come through.">
        <div className="flex items-center gap-4">
          <input
            id="w-budget"
            type="range"
            min={1}
            max={10}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            className="h-1 w-full max-w-xs cursor-pointer accent-white"
            aria-valuetext={`${budget} a day`}
          />
          <span className="font-display text-3xl leading-none text-fg tabular" aria-hidden>
            {budget}
          </span>
        </div>
      </Field>
      <Field label="After a call" hint={POST_CALL_LABELS[postCall].hint}>
        <Segmented
          label="After a call"
          value={postCall}
          onChange={setPostCall}
          options={(["off", "review", "auto"] as const).map((v) => ({ value: v, label: POST_CALL_LABELS[v].label }))}
        />
      </Field>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
        <div>
          <label htmlFor="w-briefs" className="text-sm text-body">
            Meeting briefs
          </label>
          <p className="text-xs text-muted">A one-page brief on the account and people, ready before each external meeting.</p>
        </div>
        <Switch id="w-briefs" label="Meeting briefs" checked={briefs} onChange={setBriefs} />
      </div>
      <StepFooter onBack={onBack} onSkip={skip} pending={pending || skipping} />
    </form>
  );
}

/* ───────────── h. You're set ───────────── */

export function DoneStep({
  canCopilot,
  skipped,
  missing,
  onGo,
  onBack,
}: {
  canCopilot: boolean;
  skipped: WizardStepId[];
  missing: WizardStepId[];
  onGo: (s: WizardStepId) => void;
  onBack?: () => void;
}) {
  const [pending, start] = useTransition();
  const moves = [
    { icon: <Sun className="size-4" />, title: "Start from My Day", body: "Your Today list puts the most urgent things first — replies owed, next steps due, deals going quiet.", key: null },
    { icon: <Command className="size-4" />, title: "Jump anywhere", body: "Find any deal, account or person, or run an action.", key: "K" },
    ...(canCopilot ? [{ icon: <Sparkles className="size-4" />, title: "Ask Copilot", body: "“Which of my deals have no next step?” — answers from your own pipeline.", key: "J" }] : []),
  ];
  return (
    <form
      id={STEP_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await finishOnboarding({});
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.data.redirect);
        });
      }}
    >
      {missing.length ? (
        <div role="alert" className="mb-6 rounded-lg border border-border-strong px-4 py-3">
          <p className="text-sm text-fg">One more thing before you start:</p>
          <ul className="mt-2 space-y-1">
            {missing.map((m) => (
              <li key={m}>
                <button type="button" className="text-sm text-secondary underline underline-offset-4 hover:text-fg" onClick={() => onGo(m)}>
                  {STEP_META[m].title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ol className="grid gap-3 sm:grid-cols-3">
        {moves.map((m, i) => (
          <li key={m.title} className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between text-muted">
              <span aria-hidden>{m.icon}</span>
              <span className="font-display text-sm text-muted tabular">0{i + 1}</span>
            </div>
            <p className="mt-3 text-sm font-medium text-fg">{m.title}</p>
            <p className="mt-1 text-xs text-muted">{m.body}</p>
            {m.key ? (
              <kbd className="mt-3 inline-flex rounded border border-border-strong px-1.5 py-0.5 font-sans text-[11px] text-secondary">
                <ModKey then={m.key} />
              </kbd>
            ) : null}
          </li>
        ))}
      </ol>
      {skipped.length ? (
        <p className="mt-6 text-sm text-muted">
          You skipped {skipped.map((s) => STEP_META[s].short.toLowerCase()).join(", ")} — {skipped.length === 1 ? "it stays" : "they stay"} on your My Day checklist.{" "}
          <button type="button" className="text-secondary underline underline-offset-4 hover:text-fg" onClick={() => onGo(skipped[0]!)}>
            Do it now
          </button>
        </p>
      ) : (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted">
          <CheckCircle2 className="size-4 text-good" aria-hidden /> Everything is set up.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        Change any of this later in{" "}
        <Link href="/settings" className="underline underline-offset-4 hover:text-fg">
          Settings
        </Link>
        .
      </p>
      <StepFooter onBack={onBack} pending={pending} continueDisabled={missing.length > 0} continueLabel="Start my day" />
    </form>
  );
}
