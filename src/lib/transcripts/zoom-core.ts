/**
 * Zoom webhook verification (CALL-1) — pure and unit-tested.
 * https://developers.zoom.us/docs/api/webhooks/#verify-webhook-events
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ZOOM_MAX_SKEW_SECONDS = 300;

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** endpoint.url_validation → { plainToken, encryptedToken } */
export function urlValidationResponse(plainToken: string, secret: string) {
  return { plainToken, encryptedToken: hmacHex(secret, plainToken) };
}

export function expectedSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;
}

export function verifyZoomSignature(opts: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (!opts.signature || !opts.timestamp) return { ok: false, reason: "missing signature headers" };
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  // Zoom sends seconds; tolerate milliseconds too.
  const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  if (Math.abs(nowSec - tsSec) > ZOOM_MAX_SKEW_SECONDS) return { ok: false, reason: "stale timestamp" };
  const expected = Buffer.from(expectedSignature(opts.secret, opts.timestamp, opts.rawBody));
  const got = Buffer.from(opts.signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export type ZoomRecordingFile = { id?: string; file_type?: string; file_extension?: string; download_url?: string; recording_type?: string };
export type ZoomTranscriptEvent = {
  meetingUuid: string;
  meetingId: string | null;
  topic: string | null;
  startTime: Date | null;
  durationMin: number | null;
  hostEmail: string | null;
  hostId: string | null;
  transcriptFile: { id: string; downloadUrl: string } | null;
  downloadToken: string | null;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a recording.transcript_completed (or recording.completed) payload. */
export function parseTranscriptEvent(body: unknown): ZoomTranscriptEvent | null {
  if (!isObj(body) || !isObj(body.payload) || !isObj(body.payload.object)) return null;
  const o = body.payload.object;
  const files = (Array.isArray(o.recording_files) ? o.recording_files : []) as ZoomRecordingFile[];
  const t = files.find((f) => f.file_type === "TRANSCRIPT" || f.recording_type === "audio_transcript" || f.file_extension === "VTT");
  const start = typeof o.start_time === "string" ? new Date(o.start_time) : null;
  return {
    meetingUuid: String(o.uuid ?? o.id ?? ""),
    meetingId: o.id != null ? String(o.id) : null,
    topic: typeof o.topic === "string" ? o.topic : null,
    startTime: start && !Number.isNaN(start.getTime()) ? start : null,
    durationMin: typeof o.duration === "number" ? o.duration : null,
    hostEmail: typeof o.host_email === "string" ? o.host_email.toLowerCase() : null,
    hostId: typeof o.host_id === "string" ? o.host_id : null,
    transcriptFile: t?.download_url ? { id: String(t.id ?? o.uuid), downloadUrl: t.download_url } : null,
    downloadToken: typeof body.download_token === "string" ? body.download_token : null,
  };
}

/** Zoom only allows downloads from its own hosts; never follow a URL elsewhere with a token attached. */
export function isZoomDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "zoom.us" || u.hostname.endsWith(".zoom.us") || u.hostname.endsWith(".zoomgov.com"));
  } catch {
    return false;
  }
}
