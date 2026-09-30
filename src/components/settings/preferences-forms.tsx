"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label, NativeSelect, Textarea } from "@/components/ui/input";
import { saveBlocklist, saveNotificationPrefs } from "@/lib/integrations/actions";
import type { NotificationPrefs, UserPrefs } from "@/lib/integrations/core";

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-surface-2/50">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-white" />
      <span>
        <span className="block text-sm text-body">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function NotificationForm({ prefs }: { prefs: UserPrefs }) {
  const [n, setN] = useState<NotificationPrefs>(prefs.notifications);
  const [signature, setSignature] = useState(prefs.signature);
  const [voice, setVoice] = useState(prefs.voiceSamples);
  const [pending, start] = useTransition();
  const set = <K extends keyof NotificationPrefs>(k: K, v: NotificationPrefs[K]) => setN((p) => ({ ...p, [k]: v }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveNotificationPrefs({ notifications: n, signature, voiceSamples: voice });
          if (!r.ok) toast.error(r.error);
          else toast.success("Preferences saved.");
        });
      }}
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Toggle id="n-inapp" label="In-app notifications" checked={n.inApp} onChange={(v) => set("inApp", v)} />
        <Toggle id="n-slack" label="Slack" hint="When the Slack app is installed" checked={n.slack} onChange={(v) => set("slack", v)} />
        <Toggle id="n-ai" label="AI actions" hint="Tell me when tasks are created from my email and calls" checked={n.aiActions} onChange={(v) => set("aiActions", v)} />
        <Toggle id="n-mentions" label="Mentions" checked={n.mentions} onChange={(v) => set("mentions", v)} />
        <Toggle id="n-approvals" label="Approvals" checked={n.approvals} onChange={(v) => set("approvals", v)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="n-digest">Email digest</Label>
          <NativeSelect id="n-digest" value={n.emailDigest} onChange={(e) => set("emailDigest", e.target.value as NotificationPrefs["emailDigest"])}>
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="n-sev">Alert me from</Label>
          <NativeSelect id="n-sev" value={n.minSeverity} onChange={(e) => set("minSeverity", e.target.value as NotificationPrefs["minSeverity"])}>
            <option value="info">Info and above</option>
            <option value="warning">Warning and above</option>
            <option value="serious">Serious and above</option>
            <option value="critical">Critical only</option>
          </NativeSelect>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-secondary">Quiet hours</legend>
          <div className="flex items-center gap-2">
            <NativeSelect aria-label="Quiet hours start" value={n.quietHoursStart} onChange={(e) => set("quietHoursStart", Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hour(h)}
                </option>
              ))}
            </NativeSelect>
            <span className="text-muted">–</span>
            <NativeSelect aria-label="Quiet hours end" value={n.quietHoursEnd} onChange={(e) => set("quietHoursEnd", Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hour(h)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </fieldset>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="n-signature">Email signature</Label>
          <Textarea id="n-signature" rows={4} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Alex Rep\nAccount Executive, RTB Digital"} />
          <p className="text-xs text-muted">Appended to emails sent from the CRM.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="n-voice">AI voice samples</Label>
          <Textarea id="n-voice" rows={4} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Paste 2–3 emails you've written so follow-up drafts sound like you." />
          <p className="text-xs text-muted">Used only to tune drafts; never sent to prospects.</p>
        </div>
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save preferences"}
      </Button>
    </form>
  );
}

export function BlocklistForm({ entries }: { entries: string[] }) {
  const [text, setText] = useState(entries.join("\n"));
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveBlocklist({ entries: text });
          if (!r.ok) {
            toast.error(r.error);
            return;
          }
          setText(r.data.entries.join("\n"));
          toast.success(`Blocklist saved (${r.data.count} entr${r.data.count === 1 ? "y" : "ies"}).`);
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="blocklist">Never log email or meetings with</Label>
        <Textarea
          id="blocklist"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"family.com\nmy.lawyer@firm.com\n@mybank.com"}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted">One per line: a full address blocks that sender; a domain blocks everyone at it (including subdomains). Applies to future syncs.</p>
      </div>
      <Button type="submit" variant="primary" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save blocklist"}
      </Button>
    </form>
  );
}
