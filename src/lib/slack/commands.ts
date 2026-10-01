import "server-only";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { pendingApprovalCount } from "@/lib/approvals/service";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { dealValue } from "@/lib/pipeline-math";
import { dealAccessWhere, getHiddenFields, type AppUser } from "@/lib/rbac/server";
import { formatInTz } from "@/lib/time";
import { dealSummaryMessage, helpMessage, textMessage, type SlackMessage } from "./blocks";
import { appLink, parseRtbCommand } from "./core";

/**
 * `/rtb …` slash command — answers are ephemeral (only the caller sees them), permission-checked as the mapped app
 * user (dealAccessWhere + field-level security), and MNPI-safe: restricted deals are excluded from Slack entirely,
 * even for users on the access list (Slack is a third-party store).
 */
export async function runRtbCommand(user: AppUser, text: string, appUrl: string): Promise<SlackMessage> {
  const cmd = parseRtbCommand(text);
  if (cmd.kind === "help") return helpMessage();
  if (cmd.kind === "unknown") {
    const m = helpMessage();
    return { text: m.text, blocks: [textMessage(`I don't know "${cmd.text}".`).blocks[0]!, ...m.blocks] };
  }
  if (cmd.kind === "approvals") {
    const n = await pendingApprovalCount(user);
    const url = appLink(appUrl, "/tasks?tab=approvals");
    return {
      text: `${n} approval${n === 1 ? "" : "s"} waiting on you`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: n ? `*${n}* approval${n === 1 ? " is" : "s are"} waiting on you.${url ? ` <${url}|Open approvals>` : ""}` : "Nothing is waiting on you. Nice." },
        },
      ],
    };
  }
  return dealLookup(user, cmd.query, appUrl);
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

async function dealLookup(user: AppUser, query: string, appUrl: string): Promise<SlackMessage> {
  const like = `%${escapeLike(query)}%`;
  const access = await dealAccessWhere(user, "view");
  const rows = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      status: s.deals.status,
      accountName: s.accounts.name,
      pipelineKey: s.pipelines.key,
      unit: s.pipelines.unit,
      pipelineUsdPerMuu: s.pipelines.usdPerMuu,
      pipelineRevSharePct: s.pipelines.defaultRevSharePct,
      stageName: s.stages.name,
      stageProbability: s.stages.probability,
      ownerName: s.user.name,
      muu: s.deals.muu,
      usdPerMuu: s.deals.usdPerMuu,
      revSharePct: s.deals.revSharePct,
      contractValueCents: s.deals.contractValueCents,
      annualizedValueCents: s.deals.annualizedValueCents,
      expectedCloseDate: s.deals.expectedCloseDate,
      nextStep: s.deals.nextStep,
      nextStepDueAt: s.deals.nextStepDueAt,
      healthScore: s.deals.healthScore,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
    .where(and(access, eq(s.deals.restricted, false), sql`coalesce(${s.accounts.restricted}, false) = false`, or(ilike(s.deals.name, like), ilike(s.accounts.name, like))))
    .orderBy(desc(sql`lower(${s.deals.name}) = lower(${query})`), sql`case when ${s.deals.status} = 'open' then 0 else 1 end`, desc(s.deals.updatedAt))
    .limit(6);

  if (!rows.length) return textMessage(`No deal you can see matches "${query}".`);

  const hidden = await getHiddenFields(user.role, "deal");
  const allHidden = hidden.has("*");
  const show = (f: string) => !allHidden && !hidden.has(f);
  const [d, ...rest] = rows;
  const tz = user.timezone;
  let value: string | null = null;
  if (d!.unit === "muu" && show("muu") && d!.muu) {
    const v = dealValue({ unit: "muu", muu: d!.muu, usdPerMuu: d!.usdPerMuu, pipelineUsdPerMuu: d!.pipelineUsdPerMuu, revSharePct: d!.revSharePct, pipelineRevSharePct: d!.pipelineRevSharePct, stageProbability: d!.stageProbability });
    value = `${fmtNumber(d!.muu, { compact: true })} MUU${show("usdPerMuu") ? ` · ${fmtUsd(v.grossUsd, { compact: true })}/yr gross` : ""}`;
  } else if (d!.unit === "usd" && show("contractValueCents") && show("annualizedValueCents")) {
    const cents = d!.annualizedValueCents ?? d!.contractValueCents;
    value = cents ? `${fmtUsd(cents, { cents: true, compact: true })}${d!.annualizedValueCents ? "/yr" : ""}` : null;
  }
  const nextDue = show("nextStepDueAt") ? d!.nextStepDueAt : null;
  return dealSummaryMessage(
    {
      name: d!.name,
      accountName: d!.accountName,
      pipelineKey: d!.pipelineKey,
      stageName: d!.stageName,
      status: d!.status,
      ownerName: show("ownerId") ? d!.ownerName : null,
      value,
      expectedClose: show("expectedCloseDate") && d!.expectedCloseDate ? formatInTz(d!.expectedCloseDate, tz, "date") : null,
      nextStep: show("nextStep") ? d!.nextStep : null,
      nextStepDue: nextDue ? formatInTz(nextDue, tz, "date") : null,
      nextStepOverdue: Boolean(nextDue && nextDue.getTime() < Date.now()),
      health: show("healthScore") ? d!.healthScore : null,
      href: `/deals/${d!.id}`,
    },
    appUrl,
    rest.map((r) => ({ name: r.name, href: `/deals/${r.id}` })),
  );
}
