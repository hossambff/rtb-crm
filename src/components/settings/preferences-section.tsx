"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ColorTick } from "@/components/ui/badge";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Term } from "@/components/ui/term";
import { cn } from "@/lib/utils";
import { motionTermId } from "@/lib/glossary";
import { POST_CALL_LABELS, PINNED_NAV_HREFS } from "@/lib/prefs/core";
import { savePreferences } from "@/lib/prefs/actions";

type Autopilot = { postCall: "off" | "review" | "auto"; meetingBriefs: boolean; emailSignals: boolean; forecastSuggest: boolean };
type Interruptions = { minSeverity: "info" | "warning" | "serious" | "critical"; quietHoursStart: number; quietHoursEnd: number };
const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export type PreferencesProps = {
  motions: { key: string; name: string; color: string }[];
  /** The user's explicit "motions I sell" (empty = automatic). */
  pipelineKeys: string[];
  /** What "automatic" currently resolves to, for the hint. */
  autoMotions: { keys: string[]; source: "prefs" | "owned" | "all" };
  nav: { href: string; label: string; more: boolean }[];
  alertBudgetPerDay: number;
  autopilot: Autopilot;
  slackDm: boolean;
  slackUserId: string | null;
  /** Severity floor + quiet hours (stored with the notification prefs; saved by the same button). */
  interruptions: Interruptions;
  /** Slack is connected for the org — otherwise the Slack controls are explained, not offered as a dead end. */
  slackConfigured: boolean;
};

function Switch({ id, label, hint, checked, onChange }: { id: string; label: React.ReactNode; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm text-body">
          {label}
        </label>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 after:absolute after:-inset-2.5 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
          checked ? "border-fg bg-fg" : "border-border-strong bg-surface-3",
        )}
      >
        <span className={cn("inline-block size-3.5 rounded-full transition-transform duration-150", checked ? "translate-x-[18px] bg-accent-inverse" : "translate-x-[2px] bg-secondary")} />
      </button>
    </div>
  );
}

/** One titled group. The visible title IS the legend, so screen readers announce it once (QA MIN-06). */
function Group({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-border pt-5 first:border-t-0 first:pt-0">
      <legend className="float-left w-full text-sm font-medium text-fg">{title}</legend>
      <div className="clear-left">
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        <div className="mt-3">{children}</div>
      </div>
    </fieldset>
  );
}

/** Segmented single choice with roving focus and arrow keys (QA MIN-07, WAI-ARIA radio group). */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let delta = keys[e.key];
    if (e.key === "Home") delta = -options.length;
    if (e.key === "End") delta = options.length;
    if (delta === undefined) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = Math.max(0, Math.min(options.length - 1, (i < 0 ? 0 : i) + delta));
    const wrapped = e.key.startsWith("Arrow") ? (i + delta + options.length) % options.length : next;
    onChange(options[wrapped]!.value);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[wrapped] ?? null)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={move} className="inline-flex flex-wrap rounded-md border border-border-strong p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            "touch-target rounded px-3 py-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
            value === o.value ? "bg-fg text-accent-inverse" : "text-secondary hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Settings → Preferences (V2): motions I sell, sidebar, interruptions (budget, severity, quiet hours, Slack), autopilot. */
export function PreferencesSection(p: PreferencesProps) {
  const [keys, setKeys] = useState<string[]>(p.pipelineKeys);
  const [more, setMore] = useState<string[]>(p.nav.filter((n) => n.more).map((n) => n.href));
  const [budget, setBudget] = useState(p.alertBudgetPerDay);
  const [budgetTouched, setBudgetTouched] = useState(false);
  const [intr, setIntr] = useState<Interruptions>(p.interruptions);
  const [auto, setAuto] = useState<Autopilot>(p.autopilot);
  const [slackDm, setSlackDm] = useState(p.slackDm);
  const [slackId, setSlackId] = useState(p.slackUserId ?? "");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const autoLabel =
    p.autoMotions.source === "owned"
      ? `Automatic: the motions you own deals in (${p.autoMotions.keys.join(", ")})`
      : `Automatic: all ${p.motions.length} motions you can see`;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        start(async () => {
          const r = await savePreferences({
            pipelineKeys: keys,
            moreNav: more,
            alertBudgetPerDay: budget,
            alertBudgetTouched: budgetTouched,
            interruptions: intr,
            autopilot: auto,
            slackDm,
            slackUserId: p.slackConfigured ? slackId.trim() : null,
          });
          if (!r.ok) {
            // Slack ID verification failures come back as a plain message — show it under the field too.
            setErrors(r.fieldErrors ?? (/slack/i.test(r.error) ? { slackUserId: [r.error] } : {}));
            toast.error(r.error);
          } else toast.success("Preferences saved.");
        });
      }}
    >
      {p.motions.length ? (
        <Group
          title={
            <>
              <Term id="motion">Motions</Term> I sell
            </>
          }
          description="Pipelines and deal pickers lead with these. Leave all unticked to decide automatically."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {p.motions.map((m) => {
              const term = motionTermId(m.key);
              const on = keys.includes(m.key);
              return (
                <label
                  key={m.key}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-150",
                    on ? "border-border-strong bg-surface-2" : "border-border hover:border-border-strong",
                  )}
                >
                  <input type="checkbox" className="size-4 accent-white" checked={on} onChange={() => setKeys((k) => toggle(k, m.key))} />
                  <ColorTick color={m.color} />
                  <span className="min-w-0 flex-1 truncate text-sm text-body">{m.name}</span>
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted">{term ? <Term id={term}>{m.key}</Term> : m.key}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">{keys.length ? `${keys.length} selected.` : autoLabel}</p>
        </Group>
      ) : null}

      <Group title="Sidebar" description="Switch off anything you don't use. Hidden pages stay one ⌘K away, and links from alerts and notifications keep working.">
        <ul className="grid gap-x-6 sm:grid-cols-2">
          {p.nav.map((n) =>
            PINNED_NAV_HREFS.includes(n.href) ? null : (
              <li key={n.href}>
                <Switch id={`nav-${n.href}`} label={n.label} checked={!more.includes(n.href)} onChange={() => setMore((m) => toggle(m, n.href))} />
              </li>
            ),
          )}
        </ul>
      </Group>

      <Group
        title="Interruptions"
        description="What may interrupt you (bell + Slack) and when. Everything else waits in your daily digest under “Bundled for you”. Critical alerts always come through."
      >
        <div className="space-y-1.5">
          <Label htmlFor="alert-budget">
            <Term id="alertBudget">Alert budget</Term> — interruptions per day
          </Label>
          <div className="flex items-center gap-4">
            <input
              id="alert-budget"
              type="range"
              min={1}
              max={10}
              step={1}
              value={budget}
              onChange={(e) => {
                setBudget(Number(e.target.value));
                setBudgetTouched(true);
              }}
              aria-valuetext={`${budget} per day`}
              className="h-1 w-full max-w-xs cursor-pointer accent-white"
            />
            <output htmlFor="alert-budget" className="w-24 shrink-0 text-sm text-fg tabular">
              <span className="font-display text-xl">{budget}</span> / day
            </output>
          </div>
          {errors.alertBudgetPerDay ? <p className="text-xs text-critical">{errors.alertBudgetPerDay[0]}</p> : null}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="n-sev">Alert me from</Label>
            <NativeSelect id="n-sev" value={intr.minSeverity} onChange={(e) => setIntr((x) => ({ ...x, minSeverity: e.target.value as Interruptions["minSeverity"] }))}>
              <option value="info">Info and above</option>
              <option value="warning">Warning and above</option>
              <option value="serious">Serious and above</option>
              <option value="critical">Critical only</option>
            </NativeSelect>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-secondary">Quiet hours (your time zone)</legend>
            <div className="flex items-center gap-2">
              <NativeSelect aria-label="Quiet hours start" value={intr.quietHoursStart} onChange={(e) => setIntr((x) => ({ ...x, quietHoursStart: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hour(h)}
                  </option>
                ))}
              </NativeSelect>
              <span className="text-muted" aria-hidden>
                –
              </span>
              <NativeSelect aria-label="Quiet hours end" value={intr.quietHoursEnd} onChange={(e) => setIntr((x) => ({ ...x, quietHoursEnd: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hour(h)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </fieldset>
        </div>
        <div className="mt-4 border-t border-border pt-3">
          {p.slackConfigured ? (
            <>
              <Switch id="slack-dm" label="Send interruptions as Slack DMs" checked={slackDm} onChange={setSlackDm} />
              <div className="mt-2 max-w-sm space-y-1.5">
                <Label htmlFor="slack-id">Slack member ID</Label>
                <Input
                  id="slack-id"
                  value={slackId}
                  onChange={(e) => setSlackId(e.target.value)}
                  placeholder="Found automatically from your email — or paste U0123ABCD"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.slackUserId)}
                  aria-describedby="slack-id-hint"
                  className="font-mono text-xs"
                />
                <p id="slack-id-hint" className={cn("text-xs", errors.slackUserId ? "text-critical" : "text-muted")}>
                  {errors.slackUserId?.[0] ??
                    (p.slackUserId && slackId.trim().toUpperCase() === p.slackUserId
                      ? "Linked — checked against your Slack profile email when it was saved."
                      : "Slack → your profile → ⋯ → Copy member ID. We check it belongs to your email before saving. Leave empty to match by email.")}
                </p>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">Slack DMs become available once an admin connects Slack (Admin → Slack).</p>
          )}
        </div>
      </Group>

      <Group title="Autopilot" description="What Roundtable may prepare for you. Nothing is ever sent without your click.">
        <div className="space-y-1.5">
          <p className="text-sm text-body" id="post-call-label">
            After a call
          </p>
          <Segmented
            label="After a call"
            value={auto.postCall}
            options={(Object.keys(POST_CALL_LABELS) as Autopilot["postCall"][]).map((k) => ({ value: k, label: POST_CALL_LABELS[k].label }))}
            onChange={(v) => setAuto((a) => ({ ...a, postCall: v }))}
          />
          <p className="text-xs text-muted">{POST_CALL_LABELS[auto.postCall].hint}</p>
        </div>
        <div className="mt-2 divide-y divide-border">
          <Switch id="ap-briefs" label="Meeting briefs" hint="A prep brief ~45 minutes before external meetings." checked={auto.meetingBriefs} onChange={(v) => setAuto((a) => ({ ...a, meetingBriefs: v }))} />
          <Switch id="ap-signals" label="Email & call signals" hint="Spot “send the contract” or “budget freeze” and suggest the stage change." checked={auto.emailSignals} onChange={(v) => setAuto((a) => ({ ...a, emailSignals: v }))} />
          <Switch
            id="ap-forecast"
            label="Forecast suggestions"
            hint="Each Monday, suggest commit / best case / pipeline for your deals to confirm."
            checked={auto.forecastSuggest}
            onChange={(v) => setAuto((a) => ({ ...a, forecastSuggest: v }))}
          />
        </div>
      </Group>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save preferences"}
        </Button>
        <p className="text-xs text-muted">Changes apply right away.</p>
      </div>
    </form>
  );
}
