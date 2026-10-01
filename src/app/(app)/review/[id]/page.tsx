import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { latestDecisions, recapText } from "@/lib/review/core";
import { getSessionForUser, publicDealNames, recapPostId, sessionDecisions, sessionWalkData } from "@/lib/review/queries";
import { toDateInput } from "@/lib/time";
import { Walkthrough } from "@/components/review/walkthrough";
import { Recap, type RecapItem } from "@/components/review/recap";
import { getSlackContext } from "@/lib/slack/config";

export const metadata = { title: "Pipeline review" };

export default async function ReviewSessionPage({ params }: PageProps<"/review/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const session = await getSessionForUser(user, id);
  if (!session) notFound();
  const walk = await sessionWalkData(user, session);
  const decisions = sessionDecisions(session);

  if (session.endedAt) {
    const byId = new Map(walk.deals.map((d) => [d.id, d]));
    const latest = [...latestDecisions(decisions).values()];
    const items: RecapItem[] = latest
      .filter((d) => byId.has(d.dealId)) // deals the facilitator can no longer see are left out
      .map((d) => {
        const deal = byId.get(d.dealId)!;
        return { dealId: d.dealId, name: deal.name, pipelineColor: deal.pipelineColor, restricted: deal.restricted, outcome: d.outcome, note: d.note ?? null, taskId: d.taskId ?? null };
      });
    const [names, postedId] = await Promise.all([publicDealNames(user, [...new Set(decisions.map((d) => d.dealId))]), recapPostId(session.id)]);
    const preview = recapText({ title: session.title, dealCount: session.dealIds.length, decisions, names });
    return (
      <Recap
        sessionId={session.id}
        title={session.title}
        dealCount={session.dealIds.length}
        items={items}
        tasksCreated={decisions.filter((d) => d.taskId).length}
        preview={`${preview.title}\n\n${preview.body}`}
        postedId={postedId}
        slackReady={Boolean(await getSlackContext().catch(() => null))}
      />
    );
  }

  return (
    <Walkthrough
      session={{ id: session.id, title: session.title }}
      deals={walk.deals}
      decisions={decisions}
      missing={walk.missing}
      lostReasons={walk.lostReasons}
      todayKey={toDateInput(new Date(), user.timezone)}
    />
  );
}
