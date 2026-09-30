"use client";
import { useState, useTransition } from "react";
import { AlertTriangle, FileText, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/misc";
import { sendEmail } from "@/lib/gmail/actions";
import type { ClaimHit } from "@/lib/claims-core";

export type EmailTemplate = { label: string; subject?: string; body: string };

/** Placeholder templates until the templates module lands; merge fields are filled by the rep before sending. */
export const DEFAULT_TEMPLATES: EmailTemplate[] = [
  { label: "Follow-up after call", subject: "Great speaking today", body: "Hi {{first_name}},\n\nThanks for the time today. As promised, here are the next steps:\n\n• \n\nBest," },
  { label: "Nudge", body: "Hi {{first_name}},\n\nJust bumping this to the top of your inbox — any thoughts on the above?\n\nBest," },
  { label: "Share pro forma", subject: "Pro forma for {{account}}", body: "Hi {{first_name}},\n\nAttached is the pro forma we discussed for {{account}}. Happy to walk through the assumptions on a quick call.\n\nBest," },
];

function splitEmails(v: string): string[] {
  return v
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Compose/reply through the user's Gmail (EML-8). Runs the claims check server-side; restricted/banned claims come back
 * as a confirmation step showing the approved alternatives. Embed on the deal page with `dealId` (+ `defaultTo`).
 */
export function EmailComposer({
  threadId = null,
  dealId = null,
  defaultTo = [],
  defaultCc = [],
  defaultSubject = "",
  defaultBody = "",
  canSend = true,
  templates = DEFAULT_TEMPLATES,
  onSent,
  onCancel,
  submitLabel = "Send",
}: {
  threadId?: string | null;
  dealId?: string | null;
  defaultTo?: string[];
  defaultCc?: string[];
  defaultSubject?: string;
  defaultBody?: string;
  canSend?: boolean;
  templates?: EmailTemplate[];
  onSent?: (r: { threadRowId: string | null }) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [to, setTo] = useState(defaultTo.join(", "));
  const [cc, setCc] = useState(defaultCc.join(", "));
  const [showCc, setShowCc] = useState(defaultCc.length > 0);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [hits, setHits] = useState<ClaimHit[] | null>(null);
  const [pending, start] = useTransition();
  const isReply = Boolean(threadId);

  function submit(confirmed: boolean) {
    start(async () => {
      const res = await sendEmail({ to: splitEmails(to), cc: splitEmails(cc), subject, body, threadId, dealId, confirmed });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      if (res.data.status === "confirm") {
        setHits(res.data.hits);
        return;
      }
      setHits(null);
      toast.success("Email sent from your Gmail and logged.");
      setBody("");
      onSent?.({ threadRowId: res.data.threadRowId });
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      {!canSend ? (
        <p className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-xs text-secondary">
          Sending needs the Gmail “send” permission. <a href="/settings#connections" className="text-fg underline underline-offset-2">Connect your inbox</a> first.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="composer-to">To</Label>
          {!showCc ? (
            <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setShowCc(true)}>
              Add Cc
            </button>
          ) : null}
        </div>
        <Input id="composer-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com, …" aria-invalid={Boolean(errors.to)} />
        {errors.to ? <p className="text-xs text-critical">{errors.to[0]}</p> : null}
      </div>
      {showCc ? (
        <div className="space-y-1.5">
          <Label htmlFor="composer-cc">Cc</Label>
          <Input id="composer-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
          {errors.cc ? <p className="text-xs text-critical">{errors.cc[0]}</p> : null}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="composer-subject">Subject{isReply ? <span className="ml-1 font-normal text-muted">(defaults to “Re: …”)</span> : null}</Label>
        <Input id="composer-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="composer-body">Message</Label>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
              <FileText className="size-3.5" /> Insert template
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {templates.map((t) => (
                <DropdownMenuItem
                  key={t.label}
                  onSelect={() => {
                    setBody((b) => (b.trim() ? `${b}\n\n${t.body}` : t.body));
                    if (t.subject && !subject) setSubject(t.subject);
                  }}
                >
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Textarea id="composer-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} aria-invalid={Boolean(errors.body)} />
        {errors.body ? <p className="text-xs text-critical">{errors.body[0]}</p> : null}
        {/\{\{\w+\}\}/.test(body) ? <p className="text-xs text-warning">Replace the {"{{merge fields}}"} before sending.</p> : null}
      </div>

      {hits ? (
        <div role="alert" className="space-y-2 rounded-md border border-border-strong bg-surface-2 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <AlertTriangle className="size-4 text-warning" aria-hidden /> Claims check flagged {hits.length} phrase{hits.length === 1 ? "" : "s"}
          </p>
          <ul className="space-y-1.5 text-xs text-secondary">
            {hits.map((h) => (
              <li key={h.claimId}>
                <span className="text-fg">“{h.match}”</span> — {h.status === "banned" ? "banned" : "restricted"} claim
                {h.alternative ? (
                  <>
                    . Approved alternative: <span className="text-body">“{h.alternative}”</span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setHits(null)}>
              Edit message
            </Button>
            <Button type="button" size="sm" variant="primary" disabled={pending} onClick={() => submit(true)}>
              Send anyway
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="sm" disabled={pending || !canSend || Boolean(hits)}>
          <Send /> {pending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
