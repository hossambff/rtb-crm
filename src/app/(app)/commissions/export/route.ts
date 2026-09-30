import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/rbac/server";
import { listAccruals } from "@/lib/commissions/queries";
import { audit } from "@/lib/audit";

/** Payout export for payroll/AP (COM-4). Rows are scope-filtered exactly like the ledger (reps get only their own). */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const period = req.nextUrl.searchParams.get("period") ?? undefined;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const rows = await listAccruals(user, {
    period: period && /^\d{4}-\d{2}$/.test(period) ? period : undefined,
    status: status && /^[a-z_]{3,20}$/.test(status) ? status : undefined,
  });
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    // Neutralize spreadsheet formula injection and quote.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ["period", "rep", "rep_id", "plan", "trigger", "deal", "amount_usd", "status", "note", "accrual_id"];
  const lines = [header.join(",")];
  for (const r of rows)
    lines.push([r.period, r.userName, r.userId, r.planName, r.trigger, r.dealName, (r.amountCents / 100).toFixed(2), r.status, r.note.replace(/\s+/g, " "), r.id].map(esc).join(","));
  await audit({ actorId: user.id, action: "commissions.export", entity: "commission_accruals", after: { period, status, rows: rows.length } });
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="commissions${period ? `-${period}` : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
}
