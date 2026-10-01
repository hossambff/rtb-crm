"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { saveBlocklist } from "@/lib/integrations/actions";
import { saveDraftingPrefs } from "@/lib/prefs/actions";
import type { UserPrefs } from "@/lib/integrations/core";

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

/**
 * Settings → "Email & drafting": AI-action notices, signature and voice samples. Alert budget, severity floor, quiet
 * hours and Slack live in Preferences → Interruptions (one save; QA MAJ-04). The old In-app / Mentions / Approvals /
 * email-digest switches were removed: nothing read them.
 */
export function NotificationForm({ prefs }: { prefs: UserPrefs }) {
  const [aiActions, setAiActions] = useState(prefs.notifications.aiActions);
  const [signature, setSignature] = useState(prefs.signature);
  const [voice, setVoice] = useState(prefs.voiceSamples);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveDraftingPrefs({ aiActions, signature, voiceSamples: voice });
          if (!r.ok) toast.error(r.error);
          else toast.success("Email settings saved.");
        });
      }}
    >
      <Toggle id="n-ai" label="Tell me about AI actions" hint="A notification when tasks are created from my email and calls" checked={aiActions} onChange={setAiActions} />
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
        {pending ? "Saving…" : "Save email settings"}
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
