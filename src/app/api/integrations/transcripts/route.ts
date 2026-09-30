import { NextResponse, after, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { assertCan, ForbiddenError, getCurrentUser } from "@/lib/rbac/server";
import { audit } from "@/lib/audit";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { sameOrigin } from "@/lib/integrations/secrets";
import { MAX_TRANSCRIPT_BYTES, normalizeTranscript, validateTranscriptFile } from "@/lib/transcripts/parse";
import { ingestTranscript } from "@/lib/transcripts/ingest";
import { analyzeTranscript } from "@/lib/transcripts/analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const fields = z.object({
  title: z.string().trim().max(200).optional().default(""),
  dealId: z.uuid().optional().or(z.literal("")).default(""),
  meetingId: z.uuid().optional().or(z.literal("")).default(""),
  occurredAt: z.string().optional().default(""),
  consent: z.literal("true", { message: "Confirm that participants were notified of recording/transcription." }),
  text: z.string().optional().default(""),
});

/**
 * Manual transcript upload/paste (CALL-4). A route handler (not a server action) because transcripts can be up to
 * 2 MB, above the default server-action body limit. Accepts multipart form-data with `file` or `text`.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  try {
    await assertCan(user, "calls", "create");
  } catch {
    return NextResponse.json({ error: "You don't have permission to add call transcripts." }, { status: 403 });
  }
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_TRANSCRIPT_BYTES + 64 * 1024) return NextResponse.json({ error: "The transcript is larger than 2 MB." }, { status: 413 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  const parsed = fields.safeParse({
    title: form.get("title") ?? undefined,
    dealId: form.get("dealId") ?? undefined,
    meetingId: form.get("meetingId") ?? undefined,
    occurredAt: form.get("occurredAt") ?? undefined,
    consent: form.get("consent") ?? undefined,
    text: form.get("text") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Please check the form.", fieldErrors: z.flattenError(parsed.error).fieldErrors }, { status: 400 });
  }
  const input = parsed.data;

  let raw = "";
  let name: string | null = null;
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    const err = validateTranscriptFile(file.name, file.size);
    if (err) return NextResponse.json({ error: err, fieldErrors: { file: [err] } }, { status: 400 });
    name = file.name;
    raw = await file.text();
  } else {
    raw = input.text;
    if (new TextEncoder().encode(raw).length > MAX_TRANSCRIPT_BYTES) return NextResponse.json({ error: "The transcript is larger than 2 MB." }, { status: 413 });
  }
  if (raw.trim().length < 20) return NextResponse.json({ error: "Paste or upload a transcript (at least a few lines).", fieldErrors: { text: ["Too short"] } }, { status: 400 });

  if (input.dealId) {
    const deal = await getAccessibleDeal(user, input.dealId, "view");
    if (!deal) return NextResponse.json({ error: "You can't attach transcripts to that deal." }, { status: 403 });
  }
  let meeting: { id: string; startsAt: Date | null; title: string | null; dealId: string | null } | undefined;
  if (input.meetingId) {
    [meeting] = await db
      .select({ id: s.meetings.id, startsAt: s.meetings.startsAt, title: s.meetings.title, dealId: s.meetings.dealId })
      .from(s.meetings)
      .where(and(eq(s.meetings.id, input.meetingId), eq(s.meetings.ownerId, user.id)));
    if (!meeting) return NextResponse.json({ error: "That meeting isn't on your calendar." }, { status: 403 });
  }
  const occurred = input.occurredAt ? new Date(input.occurredAt) : (meeting?.startsAt ?? new Date());
  if (Number.isNaN(occurred.getTime())) return NextResponse.json({ error: "Invalid call date." }, { status: 400 });

  try {
    const norm = normalizeTranscript(name, raw);
    const title = input.title || meeting?.title || name?.replace(/\.[^.]+$/, "") || `Call ${occurred.toISOString().slice(0, 10)}`;
    const r = await ingestTranscript({
      source: name ? "upload" : "paste",
      title,
      rawText: norm.text,
      occurredAt: occurred,
      durationMin: norm.durationMin,
      participants: norm.speakers,
      uploadedBy: user.id,
      dealId: input.dealId || meeting?.dealId || null,
      meetingId: meeting?.id ?? null,
      consent: true,
    });
    await audit({ actorId: user.id, action: "transcript.upload", entity: "transcript", entityId: r.id, after: { source: name ? "upload" : "paste", dealId: input.dealId || null, chars: norm.text.length } });
    after(async () => {
      await analyzeTranscript(r.id);
    });
    revalidatePath("/calls");
    return NextResponse.json({ ok: true, id: r.id });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    console.error("[transcripts] upload failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Something went wrong saving the transcript." }, { status: 500 });
  }
}
