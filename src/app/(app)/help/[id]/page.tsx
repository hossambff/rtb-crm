import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { getHelpRequestFor } from "@/lib/help/service";
import { isOverdue } from "@/lib/help/core";
import { HelpRequestList } from "@/components/help/request-help";

export const metadata = { title: "Help request" };

/**
 * One executive help request (V2 §C6, QA MAJ-08). Requests asked from a meeting with no deal are answered here
 * (accept / decline / done, or withdraw); requests on a deal live on the deal page and redirect there.
 * Only the requester and the person asked can open it.
 */
export default async function HelpRequestPage({ params }: PageProps<"/help/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const r = await getHelpRequestFor(user, id);
  if (!r) notFound();
  if (r.dealId) redirect(`/deals/${r.dealId}?help=${r.id}`);
  const forMe = r.target.id === user.id;
  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/home" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> Today
      </Link>
      <header className="mb-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Help request</p>
        <h1 className="font-display text-[28px] font-medium leading-9 text-fg">{forMe ? `${r.requester.name} needs your help` : `You asked ${r.target.name}`}</h1>
        {r.meetingId ? (
          <p className="mt-1.5 text-sm text-secondary">
            Asked from a meeting.{" "}
            {r.requester.id === user.id ? (
              <Link href={`/calls/briefs/${r.meetingId}`} className="underline-offset-2 hover:underline">
                Open the meeting brief
              </Link>
            ) : null}
          </p>
        ) : null}
      </header>
      <HelpRequestList requests={[{ ...r, overdue: isOverdue(r, new Date()) }]} currentUserId={user.id} focusId={r.id} />
    </div>
  );
}
