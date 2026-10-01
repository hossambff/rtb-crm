import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { getCurrentUser } from "@/lib/rbac/server";
import { forecastForDeal } from "@/lib/forecast/service";
import { CATEGORY_LABELS, quarterLabel } from "@/lib/forecast/core";
import { logServerError } from "@/lib/errors";
import { Tooltip } from "@/components/ui/misc";

/**
 * Deal page slot (owner WS-F): this week's forecast category — the rep's call (confirmed / carried from an earlier
 * week) or the system suggestion — with the reasons on hover. Renders null for deals outside the forecast window
 * (closed, no close date, or closing after next quarter) and for users who can't see the deal.
 */
export async function DealForecastBadge({ dealId }: { dealId: string }) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return null;
  let f: Awaited<ReturnType<typeof forecastForDeal>> = null;
  try {
    f = await forecastForDeal(user, dealId);
  } catch (e) {
    logServerError("forecast.badge", e);
    return null;
  }
  if (!f) return null;
  const label = f.state === "unconfirmed" ? `Suggested: ${CATEGORY_LABELS[f.suggested]}` : CATEGORY_LABELS[f.effective];
  const sub =
    f.state === "confirmed" ? "confirmed this week" : f.state === "carried" ? (f.needsConfirmation ? `suggestion: ${CATEGORY_LABELS[f.suggested]}` : "carried from last call") : "not confirmed";
  return (
    <Tooltip
      content={
        <span className="block space-y-1">
          <span className="block font-medium text-fg">
            Forecast · {quarterLabel(f.period)} · {f.engine === "stage" ? "stage probability" : "autopilot suggestion"}
          </span>
          {f.reasons.map((r) => (
            <span key={r} className="block text-secondary">
              {r}
            </span>
          ))}
          {f.note ? <span className="block text-secondary">Rep note: “{f.note}”</span> : null}
        </span>
      }
    >
      <Link
        href="/forecast"
        className="inline-flex items-center gap-1.5 rounded border border-border-strong px-1.5 py-0.5 text-[11px] font-medium leading-4 text-secondary transition-colors duration-150 hover:text-fg"
        aria-label={`Forecast ${label}, ${sub}. Open forecast`}
      >
        <TrendingUp className="size-3 text-muted" aria-hidden />
        <span className="text-fg">{label}</span>
        <span className="hidden text-muted sm:inline">· {sub}</span>
        {f.needsConfirmation && f.canEdit ? <span aria-hidden className="size-1.5 rounded-full bg-white" /> : null}
      </Link>
    </Tooltip>
  );
}
