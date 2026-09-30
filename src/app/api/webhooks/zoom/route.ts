import { NextResponse, after, type NextRequest } from "next/server";
import { getZoomSecrets, ingestZoomTranscript } from "@/lib/transcripts/zoom";
import { parseTranscriptEvent, urlValidationResponse, verifyZoomSignature } from "@/lib/transcripts/zoom-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Zoom webhook (CALL-1). Every request — including endpoint.url_validation — must carry a valid
 * x-zm-signature (v0:timestamp:body HMAC-SHA256 with the webhook secret token). Transcript download + ingest run
 * after the response so Zoom gets its 200 within 3s.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secrets = await getZoomSecrets();
  if (!secrets?.webhookSecret) return NextResponse.json({ error: "zoom not configured" }, { status: 503 });

  const verified = verifyZoomSignature({
    secret: secrets.webhookSecret,
    signature: req.headers.get("x-zm-signature"),
    timestamp: req.headers.get("x-zm-request-timestamp"),
    rawBody: raw,
  });
  if (!verified.ok) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let body: { event?: string; payload?: { plainToken?: string } };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (body.event === "endpoint.url_validation") {
    const plain = body.payload?.plainToken;
    if (typeof plain !== "string") return NextResponse.json({ error: "missing plainToken" }, { status: 400 });
    return NextResponse.json(urlValidationResponse(plain, secrets.webhookSecret));
  }

  if (body.event === "recording.transcript_completed") {
    const evt = parseTranscriptEvent(body);
    if (evt?.transcriptFile) {
      after(async () => {
        try {
          await ingestZoomTranscript(evt);
        } catch (e) {
          console.error("[zoom webhook] ingest failed", e instanceof Error ? e.name : "error");
        }
      });
    }
  }
  return NextResponse.json({ ok: true });
}
