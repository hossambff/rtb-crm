import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import { db } from "@/db";
import * as s from "@/db/schema";
import { requireUser, scopeFor } from "@/lib/rbac/server";
import { getSetting } from "@/lib/settings";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { UploadForm } from "@/components/calls/upload-form";

export const metadata = { title: "Add transcript" };

const DEFAULT_CONSENT =
  "I confirm all participants were told this call was recorded/transcribed, as required by RTB policy and applicable law.";
const uuid = /^[0-9a-f-]{36}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function localInput(d: Date | null, tz: string): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export default async function UploadTranscriptPage({ searchParams }: PageProps<"/calls/upload">) {
  const user = await requireUser();
  if ((await scopeFor(user, "calls", "create")) === "none") {
    return <EmptyState title="No access" description="Your role can't add call transcripts." />;
  }
  const sp = await searchParams;
  const dealId = one(sp.dealId);
  const meetingId = one(sp.meetingId);
  const deal = dealId && uuid.test(dealId) ? await getAccessibleDeal(user, dealId, "view") : null;
  const [meeting] =
    meetingId && uuid.test(meetingId)
      ? await db
          .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt })
          .from(s.meetings)
          .where(and(eq(s.meetings.id, meetingId), eq(s.meetings.ownerId, user.id)))
      : [];
  const consentText = await getSetting<string>("calls.consent_text", DEFAULT_CONSENT);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/calls" className="-my-2 mb-1 inline-flex items-center gap-1 py-2 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> Calls
      </Link>
      <PageHeader title="Add a transcript" description="Upload a .txt, .vtt, .srt or .md file, or paste the text. We'll summarize it and extract action items for review." />
      <Card>
        <CardContent className="py-5">
          <UploadForm
            initialDeal={deal ? { id: deal.id, name: deal.name, subtitle: deal.pipelineKey } : null}
            meeting={meeting ? { id: meeting.id, title: meeting.title, startsAtLocal: localInput(meeting.startsAt, user.timezone) } : null}
            consentText={typeof consentText === "string" && consentText.trim() ? consentText : DEFAULT_CONSENT}
          />
        </CardContent>
      </Card>
    </div>
  );
}
