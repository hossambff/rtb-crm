"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, Send, Unplug, Users } from "lucide-react";
import { AdminSection, ConfirmButton, Field, Switch, useAction } from "@/components/admin/form";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disconnectSlackAction, mapSlackUsersAction, saveSlackChannelsAction, sendSlackTestAction } from "@/lib/slack/actions";
import type { SlackAdminView } from "@/lib/slack/admin";
import { fmtRelative } from "@/lib/format";

const SCOPES = ["chat:write", "users:read", "users:read.email", "commands", "im:write"];

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">{label}</p>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          size="icon"
          variant="secondary"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error("Couldn't copy");
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

function Credentials({ view, readOnly }: { view: SlackAdminView; readOnly: boolean }) {
  const router = useRouter();
  const [botToken, setBotToken] = React.useState("");
  const [signingSecret, setSigningSecret] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const save = () =>
    start(async () => {
      const res = await fetch("/api/slack/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken, signingSecret }),
      }).catch(() => null);
      const json = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; teamName?: string | null; fieldErrors?: Record<string, string[]> } | null;
      if (!res?.ok || !json?.ok) {
        setErrors(json?.fieldErrors ?? {});
        return void toast.error(json?.error ?? "Couldn't save. Try again.");
      }
      setErrors({});
      setBotToken("");
      setSigningSecret("");
      toast.success(json.teamName ? `Connected to ${json.teamName}` : "Slack connected");
      router.refresh();
    });
  const keep = view.connected ? "Leave blank to keep the current value" : undefined;
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label="Bot User OAuth Token" htmlFor="slack-token" error={errors.botToken} hint={view.botTokenMasked ? `Saved: ${view.botTokenMasked}. ${keep}` : "Starts with xoxb- (OAuth & Permissions)."}>
        <Input id="slack-token" type="password" autoComplete="off" spellCheck={false} value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="xoxb-…" disabled={readOnly} />
      </Field>
      <Field label="Signing secret" htmlFor="slack-secret" error={errors.signingSecret} hint={view.signingSecretSet ? `Saved. ${keep}` : "Basic Information → App Credentials."}>
        <Input id="slack-secret" type="password" autoComplete="off" spellCheck={false} value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} placeholder="32 characters" disabled={readOnly} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={readOnly || pending || (!botToken.trim() && !signingSecret.trim())}>
          {pending ? "Verifying…" : view.connected ? "Update credentials" : "Connect Slack"}
        </Button>
        <p className="text-xs text-muted">The token is verified with Slack before it is saved. Both values are encrypted at rest and never shown again.</p>
      </div>
    </form>
  );
}

function Channels({ view, readOnly }: { view: SlackAdminView; readOnly: boolean }) {
  const [c, setC] = React.useState(view.channels);
  const { run, pending, errors } = useAction(saveSlackChannelsAction, { success: "Channels saved" });
  const test = useAction(sendSlackTestAction, { success: (m) => m });
  const set = (k: keyof typeof c, v: string | boolean) => setC((p) => ({ ...p, [k]: v }));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Alerts channel" htmlFor="ch-alerts" error={errors.alertsChannel} hint="New critical alerts (never restricted records) and the test message. Everything else goes to people as DMs.">
          <div className="flex gap-2">
            <Input id="ch-alerts" value={c.alertsChannel} onChange={(e) => set("alertsChannel", e.target.value)} placeholder="#sales-alerts or C0123ABCD" disabled={readOnly} />
            <Button type="button" size="icon" variant="secondary" aria-label="Send a test message to the alerts channel" disabled={readOnly || test.pending || !view.channels.alertsChannel} onClick={() => test.run({ target: "alerts" })}>
              <Send />
            </Button>
          </div>
        </Field>
        <Field label="Wins channel" htmlFor="ch-wins" error={errors.winsChannel} hint="Win / loss stories from the team feed (never restricted deals).">
          <div className="flex gap-2">
            <Input id="ch-wins" value={c.winsChannel} onChange={(e) => set("winsChannel", e.target.value)} placeholder="#wins" disabled={readOnly} />
            <Button type="button" size="icon" variant="secondary" aria-label="Send a test message to the wins channel" disabled={readOnly || test.pending || !view.channels.winsChannel} onClick={() => test.run({ target: "wins" })}>
              <Send />
            </Button>
          </div>
        </Field>
      </div>
      <div className="rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-fg">Daily digest</p>
            <p className="text-xs text-muted">Approvals waiting, yesterday’s wins and new deals — posted once each morning. Restricted records are excluded.</p>
          </div>
          <Switch checked={c.digestEnabled} onCheckedChange={(v) => set("digestEnabled", v)} label="Post a daily digest" disabled={readOnly} />
        </div>
        {c.digestEnabled ? (
          <div className="mt-3 max-w-sm">
            <Field label="Digest channel" htmlFor="ch-digest" error={errors.digestChannel}>
              <Input id="ch-digest" value={c.digestChannel} onChange={(e) => set("digestChannel", e.target.value)} placeholder="#sales" disabled={readOnly} />
            </Field>
          </div>
        ) : null}
      </div>
      <div>
        <p className="text-xs font-medium text-secondary">Deal channels</p>
        <p className="mb-2 text-xs text-muted">New comments on a pipeline’s deals are mirrored here (threaded replies stay threaded). Leave empty to keep discussions in Roundtable.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {view.pipelines.map((p) => (
            <label key={p.key} className="flex items-center gap-2">
              <ColorTick color={p.color} />
              <span className="w-16 shrink-0 text-xs text-secondary">{p.key}</span>
              <Input
                value={c.dealChannels[p.key] ?? ""}
                aria-label={`${p.name} deal channel`}
                placeholder={`#deals-${p.key.toLowerCase()}`}
                disabled={readOnly}
                onChange={(e) => setC((prev) => ({ ...prev, dealChannels: { ...prev.dealChannels, [p.key]: e.target.value } }))}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={readOnly || pending} onClick={() => run(c)}>
          {pending ? "Saving…" : "Save channels"}
        </Button>
        <p className="text-xs text-muted">Invite the bot to each channel first (<span className="font-mono">/invite @Roundtable</span>).</p>
      </div>
    </div>
  );
}

export function SlackAdmin({ view, readOnly }: { view: SlackAdminView; readOnly: boolean }) {
  const mapping = useAction(mapSlackUsersAction, {
    success: (r) => `Mapped ${r.mapped} of ${r.checked}${r.notFound ? ` · ${r.notFound} not found in Slack` : ""}${r.remaining ? ` · ${r.remaining} left, run again` : ""}`,
  });
  const test = useAction(sendSlackTestAction, { success: (m) => m });
  const disconnect = useAction(disconnectSlackAction, { success: "Slack disconnected" });
  const pct = view.people.total ? Math.round((view.people.mapped / view.people.total) * 100) : 0;

  return (
    <>
      <AdminSection
        title="Slack"
        description="DMs for interrupting alerts, Approve / Reject from Slack, /rtb deal lookups, wins and deal-channel mirroring. Restricted (MNPI) records never reach Slack."
        actions={
          view.connected ? (
            <StatusBadge status="good" label={view.teamName ? `Connected · ${view.teamName}` : "Connected"} />
          ) : (
            <StatusBadge status="info" label="Not connected" />
          )
        }
      >
        {!view.encryptionReady ? (
          <p role="alert" className="mb-4 rounded-md border border-border-strong px-3 py-2 text-xs text-secondary">
            ENCRYPTION_KEY is not set on the server, so secrets can’t be stored yet.
          </p>
        ) : null}
        {!view.connected ? (
          <ol className="mb-5 grid gap-3 text-sm text-secondary sm:grid-cols-3">
            {[
              ["Create the app", "api.slack.com/apps → Create New App → From scratch, in your workspace."],
              ["Add scopes & URLs", "Bot scopes below, then Interactivity and the /rtb slash command with these URLs. Install to workspace."],
              ["Paste credentials", "Bot User OAuth Token and signing secret below. Full guide: docs/SLACK_SETUP.md."],
            ].map(([t, d], i) => (
              <li key={t} className="rounded-md border border-border p-3">
                <p className="flex items-center gap-2 text-fg">
                  <span className="grid size-5 place-items-center rounded-full border border-border-strong text-[11px] tabular-nums">{i + 1}</span>
                  {t}
                </p>
                <p className="mt-1 text-xs text-muted">{d}</p>
              </li>
            ))}
          </ol>
        ) : null}
        <Credentials view={view} readOnly={readOnly} />
        <div className="mt-6 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <CopyField label="Interactivity request URL" value={view.urls.interactions} />
          <CopyField label="Slash command /rtb request URL" value={view.urls.commands} />
          <div className="sm:col-span-2">
            <p className="text-xs text-muted">Bot token scopes</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {SCOPES.map((s) => (
                <code key={s} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                  {s}
                </code>
              ))}
            </p>
          </div>
        </div>
        {view.connected ? (
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button variant="secondary" size="sm" disabled={readOnly || test.pending} onClick={() => test.run({ target: "me" })}>
              <Send /> DM me a test
            </Button>
            {view.lastTestAt ? <span className="text-xs text-muted" suppressHydrationWarning title={view.lastTestAt}>Last test {fmtRelative(view.lastTestAt)}</span> : null}
            <span className="flex-1" />
            <ConfirmButton
              size="sm"
              variant="ghost"
              disabled={readOnly}
              title="Disconnect Slack?"
              description="Stored credentials are deleted. DMs, approvals from Slack, /rtb and channel posts stop until you connect again. People’s Slack mappings are kept."
              confirmLabel="Disconnect"
              onConfirm={() => disconnect.run({})}
            >
              <Unplug /> Disconnect
            </ConfirmButton>
          </div>
        ) : null}
      </AdminSection>

      {view.connected ? (
        <>
          <AdminSection title="Channels" description="Where Roundtable posts. Channel IDs are safest (names break when a channel is renamed).">
            <Channels view={view} readOnly={readOnly} />
          </AdminSection>
          <AdminSection
            title="People"
            description="People are matched to Slack by email (users.lookupByEmail). Each person turns Slack DMs on in Settings → Preferences."
            actions={
              <Button size="sm" variant="secondary" disabled={readOnly || mapping.pending} onClick={() => mapping.run({})}>
                <Users /> {mapping.pending ? "Matching…" : "Match by email"}
              </Button>
            }
          >
            <div className="flex flex-wrap items-end gap-8">
              <div>
                <p className="font-display text-3xl text-fg tabular-nums">
                  {view.people.mapped}
                  <span className="text-lg text-muted">/{view.people.total}</span>
                </p>
                <p className="text-xs text-muted">mapped to Slack</p>
              </div>
              <div>
                <p className="font-display text-3xl text-fg tabular-nums">{view.people.dmOn}</p>
                <p className="text-xs text-muted">with DMs on</p>
              </div>
              <div className="min-w-40 flex-1">
                <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="People mapped">
                  <div className="h-full rounded-full bg-white transition-[width] duration-200" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          </AdminSection>
        </>
      ) : null}
    </>
  );
}
