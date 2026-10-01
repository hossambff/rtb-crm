"use client";
import { Suspense, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Calendar, Mail, Pause, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { confirmGoogleConnected, setInboxSync } from "@/lib/integrations/actions";
import type { ConnectionView } from "@/lib/integrations/queries";
import { ConnectionStatus } from "./connection-status";

const withParam = (path: string, param: string) => `${path}${path.includes("?") ? "&" : "?"}${param}`;

type GoogleState = {
  configured: boolean;
  linked: boolean;
  gmailRead: boolean;
  gmailSend: boolean;
  calendar: boolean;
  gmail: ConnectionView | null;
  calendarConn: ConnectionView | null;
};

/** Handles the `?connected=` return from Google's consent screen. Isolated so the card itself never suspends. */
function ConnectCallback({ back }: { back: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const confirmed = useRef(false);
  useEffect(() => {
    const flag = params.get("connected");
    if (!flag || confirmed.current) return;
    confirmed.current = true;
    if (flag !== "google") {
      toast.error("Google authorization was cancelled or failed.");
      router.replace(back);
      return;
    }
    void confirmGoogleConnected({}).then((res) => {
      if (res.ok && res.data.connected) toast.success("Inbox connected. The first sync is running in the background.");
      else if (res.ok) toast.error("Google didn't grant Gmail access. Try again and allow all requested permissions.");
      router.replace(back);
      router.refresh();
    });
  }, [params, router, back]);
  return null;
}

/**
 * Gmail + Calendar via incremental Google authorization (Better Auth linkSocial with extra scopes). Always rendered.
 * `returnTo` = the page Google sends the person back to (Settings by default; the /welcome wizard passes its tools step).
 */
export function GoogleConnection({
  state,
  scopes,
  required,
  returnTo = "/settings",
  backTo = "/settings#connections",
}: {
  state: GoogleState;
  scopes: string[];
  required: boolean;
  returnTo?: string;
  backTo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const connected = state.gmailRead && state.calendar;
  const paused = state.gmail?.status === "revoked";

  async function connect() {
    setBusy(true);
    const { error } = await authClient.linkSocial({ provider: "google", scopes, callbackURL: withParam(returnTo, "connected=google"), errorCallbackURL: withParam(returnTo, "connected=error") });
    if (error) {
      setBusy(false);
      toast.error(error.message ?? "Couldn't start Google authorization.");
    }
  }

  const gmailResult = state.gmail?.lastResult as { ingested?: number; mode?: string; done?: boolean } | null;
  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <ConnectCallback back={backTo} />
      </Suspense>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Mail className="size-4 text-muted" aria-hidden /> Gmail
            <span className="text-muted">+</span>
            <Calendar className="size-4 text-muted" aria-hidden /> Google Calendar
          </p>
          <p className="max-w-xl text-xs text-muted">
            Only threads with known contacts or account domains are logged. Personal threads, internal-only threads and your blocklist are never
            stored. Sending uses your own Gmail.{required ? " Required for your role." : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => {
                const r = await setInboxSync({ enabled: paused });
                if (!r.ok) toast.error(r.error);
                else toast.success(paused ? "Inbox sync resumed." : "Inbox sync paused.");
              })}>
                {paused ? <Play /> : <Pause />} {paused ? "Resume sync" : "Pause sync"}
              </Button>
              <Button size="sm" variant="ghost" onClick={connect} disabled={busy || !state.configured}>
                <RefreshCw /> Reconnect
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={connect} disabled={busy || !state.configured} title={state.configured ? undefined : "Google sign-in isn't configured on this server"}>
              {busy ? "Opening Google…" : state.configured ? "Connect inbox" : "Not available"}
            </Button>
          )}
        </div>
      </div>

      {!state.configured ? (
        <div role="status" className="flex items-start gap-2.5 rounded-md border border-dashed border-border-strong px-3 py-2.5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-fg">Google sign-in not configured — ask an admin</p>
            <p className="text-xs text-muted">
              An admin needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server before Gmail and Calendar can be connected. Until then
              email and meetings aren&apos;t captured automatically; log them on the deal instead.
            </p>
          </div>
        </div>
      ) : null}

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-border px-3 py-2.5">
          <dt className="text-xs text-muted">Inbox sync</dt>
          <dd className="mt-1 space-y-1">
            {state.gmailRead ? <ConnectionStatus status={state.gmail?.status ?? "connected"} lastSyncAt={state.gmail?.lastSyncAt} /> : <ConnectionStatus status={null} />}
            {state.gmail?.lastError ? <p className="text-xs text-critical">{state.gmail.lastError}</p> : null}
            {gmailResult && gmailResult.mode === "backfill" && !gmailResult.done ? <p className="text-xs text-muted">Backfill in progress…</p> : null}
            {state.gmailRead && !state.gmailSend ? <p className="text-xs text-warning">Send permission missing — reconnect to send from the CRM.</p> : null}
          </dd>
        </div>
        <div className="rounded-md border border-border px-3 py-2.5">
          <dt className="text-xs text-muted">Calendar sync</dt>
          <dd className="mt-1 space-y-1">
            {state.calendar ? (
              <ConnectionStatus status={state.calendarConn?.status ?? "connected"} lastSyncAt={state.calendarConn?.lastSyncAt} />
            ) : (
              <ConnectionStatus status={null} />
            )}
            {state.calendarConn?.lastError ? <p className="text-xs text-critical">{state.calendarConn.lastError}</p> : null}
          </dd>
        </div>
      </dl>
    </div>
  );
}
