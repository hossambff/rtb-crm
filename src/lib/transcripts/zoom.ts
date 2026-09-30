import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getConnection } from "@/lib/integrations/store";
import { isZoomDownloadUrl, type ZoomTranscriptEvent } from "./zoom-core";
import { MAX_TRANSCRIPT_BYTES, normalizeTranscript } from "./parse";
import { ingestTranscript } from "./ingest";
import { analyzeTranscript } from "./analyze";

/** Org-level Zoom credentials (Server-to-Server OAuth app + webhook secret token), encrypted as one JSON blob. */
export type ZoomSecrets = { accountId: string; clientId: string; clientSecret: string; webhookSecret: string };

export async function getZoomSecrets(): Promise<ZoomSecrets | null> {
  const conn = await getConnection(null, "zoom");
  if (conn && conn.status !== "revoked" && conn.secretEncrypted) {
    try {
      return JSON.parse(decryptSecret(conn.secretEncrypted)) as ZoomSecrets;
    } catch {
      return null;
    }
  }
  const envSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  return envSecret ? { accountId: "", clientId: "", clientSecret: "", webhookSecret: envSecret } : null;
}

/** Server-to-Server OAuth token (used when the webhook's download_token is missing or expired). */
export async function zoomAccessToken(secrets: ZoomSecrets): Promise<string | null> {
  if (!secrets.accountId || !secrets.clientId || !secrets.clientSecret) return null;
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(secrets.accountId)}`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function download(url: string, token: string): Promise<string | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow", signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_TRANSCRIPT_BYTES * 2) return null;
  return new TextDecoder().decode(buf);
}

/** recording.transcript_completed → download VTT → ingest → analyze. Idempotent (source zoom + file id). */
export async function ingestZoomTranscript(evt: ZoomTranscriptEvent): Promise<{ status: string; transcriptId?: string }> {
  if (!evt.transcriptFile) return { status: "no_transcript_file" };
  if (!isZoomDownloadUrl(evt.transcriptFile.downloadUrl)) return { status: "bad_download_url" };
  const externalId = evt.transcriptFile.id;
  const [dup] = await db
    .select({ id: s.transcripts.id })
    .from(s.transcripts)
    .where(and(eq(s.transcripts.source, "zoom"), eq(s.transcripts.externalId, externalId)))
    .limit(1);
  if (dup) return { status: "duplicate", transcriptId: dup.id };

  let text: string | null = null;
  if (evt.downloadToken) text = await download(evt.transcriptFile.downloadUrl, evt.downloadToken);
  if (!text) {
    const secrets = await getZoomSecrets();
    const token = secrets ? await zoomAccessToken(secrets) : null;
    if (token) text = await download(evt.transcriptFile.downloadUrl, token);
  }
  if (!text) return { status: "download_failed" };

  const [host] = evt.hostEmail
    ? await db.select({ id: s.user.id }).from(s.user).where(sql`lower(${s.user.email}) = ${evt.hostEmail}`).limit(1)
    : [];
  const norm = normalizeTranscript("zoom.vtt", text);
  const r = await ingestTranscript({
    source: "zoom",
    externalId,
    title: evt.topic,
    rawText: norm.text,
    occurredAt: evt.startTime,
    durationMin: evt.durationMin ?? norm.durationMin,
    participants: norm.speakers,
    uploadedBy: host?.id ?? null,
  });
  if (r.created) await analyzeTranscript(r.id);
  return { status: r.created ? "ingested" : "duplicate", transcriptId: r.id };
}
