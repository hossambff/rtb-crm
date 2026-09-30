import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, modelFor } from "@/lib/ai";
import { env } from "@/lib/env";
import { isUuid } from "@/lib/copilot/guards";
import { accountAccessible, loadAccessibleDeal } from "@/lib/copilot/queries";
import type { CopilotContext } from "@/lib/copilot/types";
import { requireUser, scopeFor } from "@/lib/rbac/server";
import { EmptyState } from "@/components/ui/misc";
import { CopilotPageClient } from "./page-client";

export const metadata = { title: "Copilot" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CopilotPage({ searchParams }: PageProps<"/copilot">) {
  const user = await requireUser();
  if ((await scopeFor(user, "copilot", "use_ai")) === "none") {
    return <EmptyState title="Copilot is not enabled for your role" description="Ask an admin to grant Copilot access (module Copilot → use AI)." />;
  }
  const sp = await searchParams;
  const context: CopilotContext = {};
  const labels: string[] = [];
  const dealId = first(sp.dealId);
  const accountId = first(sp.accountId);
  const meetingId = first(sp.meetingId);
  const alertId = first(sp.alertId);
  if (isUuid(dealId)) {
    const d = await loadAccessibleDeal(user, dealId, "view");
    if (d) {
      context.dealId = d.id;
      labels.push(d.name);
    }
  }
  if (isUuid(accountId) && (await accountAccessible(user, accountId))) {
    const [a] = await db.select({ name: s.accounts.name }).from(s.accounts).where(eq(s.accounts.id, accountId));
    if (a) {
      context.accountId = accountId;
      labels.push(a.name);
    }
  }
  if (isUuid(meetingId)) {
    const [m] = await db.select({ title: s.meetings.title, ownerId: s.meetings.ownerId, dealId: s.meetings.dealId }).from(s.meetings).where(eq(s.meetings.id, meetingId));
    if (m && (m.ownerId === user.id || (m.dealId && (await loadAccessibleDeal(user, m.dealId, "view"))))) {
      context.meetingId = meetingId;
      labels.push(m.title ?? "Meeting");
    }
  }
  if (isUuid(alertId)) {
    const [a] = await db.select({ title: s.alerts.title, recipientId: s.alerts.recipientId }).from(s.alerts).where(eq(s.alerts.id, alertId));
    if (a && a.recipientId === user.id) {
      context.alertId = alertId;
      labels.push(a.title);
    }
  }
  const q = first(sp.q)?.slice(0, 2000);
  const model = await modelFor("strong");

  return (
    <CopilotPageClient
      userId={user.id}
      model={model}
      aiEnabled={aiAvailable()}
      webResearch={Boolean(env.apifyToken)}
      context={context}
      contextLabel={labels.join(" · ") || null}
      initialPrompt={q}
    />
  );
}
