"use client";
import { useState, useTransition } from "react";
import { Copy, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { revokeZoom } from "@/lib/integrations/actions";
import { ConnectionStatus } from "./connection-status";

type ZoomState = { connected: boolean; status: string | null; accountId: string; clientIdMasked: string | null; updatedAt: string | null; webhookUrl: string };

/** Admin-only: org-level Zoom Server-to-Server OAuth app + webhook secret token (CALL-1). */
export function ZoomForm({ state }: { state: ZoomState }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(state.accountId);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const keep = state.connected ? "Leave blank to keep the saved value" : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Video className="size-4 text-muted" aria-hidden /> Zoom <span className="text-xs font-normal text-muted">(organization · admin only)</span>
          </p>
          <p className="max-w-xl text-xs text-muted">
            Create a Server-to-Server OAuth app in the Zoom Marketplace with the <code>recording:read</code> scope and subscribe to “Recording
            transcript files have completed”. Cloud-recording transcripts are then ingested automatically.
          </p>
        </div>
        <ConnectionStatus status={state.connected ? (state.status ?? "connected") : null} />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
        <span className="text-muted">Event notification endpoint URL</span>
        <code className="truncate font-mono text-secondary">{state.webhookUrl}</code>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Copy webhook URL"
          onClick={() => {
            void navigator.clipboard.writeText(state.webhookUrl).then(() => toast.success("Copied."));
          }}
        >
          <Copy />
        </Button>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            // Route handler (not a server action) so secrets never appear in dev server-function logs.
            const res = await fetch("/api/integrations/zoom", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ accountId, clientId, clientSecret, webhookSecret }),
            }).catch(() => null);
            const json = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; fieldErrors?: Record<string, string[]> } | null;
            if (!res?.ok || !json?.ok) {
              setErrors(json?.fieldErrors ?? {});
              toast.error(json?.error ?? "Couldn't save the Zoom connection.");
              return;
            }
            router.refresh();
            setErrors({});
            setClientId("");
            setClientSecret("");
            setWebhookSecret("");
            toast.success("Zoom connection saved.");
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="zoom-account">Account ID</Label>
          <Input id="zoom-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" />
          {errors.accountId ? <p className="text-xs text-critical">{errors.accountId[0]}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="zoom-client">Client ID{state.clientIdMasked ? <span className="ml-1 font-normal text-muted">({state.clientIdMasked})</span> : null}</Label>
          <Input id="zoom-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={keep} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="zoom-secret">Client secret</Label>
          <Input id="zoom-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={keep} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="zoom-webhook">Webhook secret token</Label>
          <Input id="zoom-webhook" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={keep} autoComplete="off" />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            {pending ? "Saving…" : state.connected ? "Update Zoom" : "Connect Zoom"}
          </Button>
          {state.connected ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await revokeZoom({});
                  if (!r.ok) toast.error(r.error);
                  else toast.success("Zoom disconnected.");
                })
              }
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
