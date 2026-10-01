"use client";
import * as React from "react";
import { toast } from "sonner";
import { AlertOctagon, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STATUS_COLORS } from "@/lib/palette";
import { requestMoreBudget } from "@/lib/scout/actions";
import { usd } from "./bits";

export type EstimateLine = { purpose: string; actorId: string | null; results: number; costPerResultUsd: number; cents: number };
export type BudgetView = {
  allowed: boolean;
  message: string;
  canRequestMore: boolean;
  orgRemainingCents: number;
  userRemainingCents: number;
  userCapCents: number;
  orgCapCents: number;
  estimateCents: number;
};

const PURPOSE_LABEL: Record<string, string> = {
  lookalike: "Lookalike discovery",
  serp: "Keyword discovery",
  traffic: "Traffic / MUU",
  tech_stack: "Tech stack",
  website_contacts: "Website contacts",
  people: "Executives",
  email_from_linkedin: "Email from LinkedIn",
  email_finder: "Email pattern + SMTP",
  email_verify: "Verification",
};

/** Cost estimate (items × cost per result) + budget decision, with "request more budget" when a manager can lift it. */
export function CostEstimate({
  lines,
  budget,
  entity,
  entityId,
  pendingRequest,
}: {
  lines: EstimateLine[];
  budget: BudgetView;
  entity: "scout_search" | "account";
  entityId?: string;
  pendingRequest?: boolean;
}) {
  const [requested, setRequested] = React.useState(Boolean(pendingRequest));
  const [busy, setBusy] = React.useState(false);
  const total = lines.reduce((a, l) => a + l.cents, 0);
  return (
    <div className="rounded-md border border-border bg-surface-1">
      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full text-xs">
          <caption className="sr-only">Apify cost estimate</caption>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className="px-3 py-2 text-muted">No Apify calls — this run is free.</td>
              </tr>
            ) : (
              lines.map((l) => (
                <tr key={l.purpose} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-secondary">{PURPOSE_LABEL[l.purpose] ?? l.purpose}</td>
                  <td className="break-all px-3 py-1.5 font-mono text-[11px] text-muted">{l.actorId ?? "no actor"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular text-muted">
                    {l.results} × ${l.costPerResultUsd.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular text-body">{usd(l.cents)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-border">
              <td className="px-3 py-2 font-medium text-fg" colSpan={3}>
                Estimated cost
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular text-fg">{usd(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
        {budget.allowed ? (
          <CheckCircle2 className="size-3.5" style={{ color: STATUS_COLORS.good }} aria-hidden />
        ) : (
          <AlertOctagon className="size-3.5" style={{ color: STATUS_COLORS.serious }} aria-hidden />
        )}
        <span className="flex-1 text-secondary">{budget.message}</span>
        <span className="tabular text-muted">
          You: {usd(budget.userRemainingCents)} left of {usd(budget.userCapCents)} · Org: {usd(budget.orgRemainingCents)} of {usd(budget.orgCapCents)}
        </span>
        {!budget.allowed && budget.canRequestMore && entityId ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={requested || busy}
            onClick={async () => {
              setBusy(true);
              const r = await requestMoreBudget({ entity, entityId, amountCents: Math.max(budget.estimateCents, total), reason: "Run exceeds my Lead Scout budget" });
              setBusy(false);
              if (r.ok) {
                setRequested(true);
                toast.success(r.data.duplicate ? "Request already pending with your SVP" : "Budget request sent to your SVP");
              } else toast.error(r.error);
            }}
          >
            {requested ? "Request pending" : "Request more budget"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
