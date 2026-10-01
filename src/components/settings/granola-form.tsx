"use client";
import { useState, useTransition } from "react";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { revokeGranolaKey, syncGranolaNow } from "@/lib/integrations/actions";
import type { ConnectionView } from "@/lib/integrations/queries";
import { ConnectionStatus } from "./connection-status";

/** Per-user Granola API key (D6). Stored encrypted; only a masked hint is ever sent back to the browser. */
export function GranolaForm({ conn }: { conn: ConnectionView | null }) {
  const router = useRouter();
  const active = conn && conn.status !== "revoked" && conn.masked;
  const [editing, setEditing] = useState(!active);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const result = conn?.lastResult as { ingested?: number; updated?: number } | null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <KeyRound className="size-4 text-muted" aria-hidden /> Granola
          </p>
          <p className="max-w-xl text-xs text-muted">
            Your personal Granola API key (Granola → Settings → API). New notes and transcripts are pulled automatically and matched to your
            meetings and deals.
          </p>
        </div>
        {active ? <ConnectionStatus status={conn.status} lastSyncAt={conn.lastSyncAt} /> : <ConnectionStatus status={null} />}
      </div>
      {conn?.lastError && conn.status !== "revoked" ? <p className="text-xs text-critical">{conn.lastError}</p> : null}

      {active && !editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-secondary">{conn.masked}</code>
          {result ? <span className="text-xs text-muted">Last run: {result.ingested ?? 0} new, {result.updated ?? 0} updated</span> : null}
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await syncGranolaNow({});
                  if (!r.ok) toast.error(r.error);
                  else toast.success(`Granola synced: ${r.data.ingested} new, ${r.data.updated} updated.`);
                })
              }
            >
              <RefreshCw /> Sync now
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Replace key
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await revokeGranolaKey({});
                  if (!r.ok) toast.error(r.error);
                  else {
                    toast.success("Granola key removed.");
                    setEditing(true);
                  }
                })
              }
            >
              <Trash2 /> Revoke
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              // Route handler (not a server action) so the key never appears in dev server-function logs.
              const res = await fetch("/api/integrations/granola", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key }),
              }).catch(() => null);
              const json = (await res?.json().catch(() => null)) as { ok?: boolean; warning?: string | null; error?: string } | null;
              if (!res?.ok || !json?.ok) {
                setError(json?.error ?? "Couldn't save the key. Please try again.");
                return;
              }
              setError(null);
              setKey("");
              setEditing(false);
              if (json.warning) toast.warning(json.warning);
              else toast.success("Granola connected and key verified.");
              router.refresh();
            });
          }}
        >
          <div className="w-full space-y-1.5 sm:w-auto sm:min-w-64 sm:flex-1">
            <Label htmlFor="granola-key">API key</Label>
            <Input
              id="granola-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste your Granola API key"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "granola-key-error" : undefined}
            />
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={pending || !key.trim()} className="h-9">
            {pending ? "Verifying…" : "Save & verify"}
          </Button>
          {active ? (
            <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
          {error ? (
            <p id="granola-key-error" className="w-full text-xs text-critical">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
