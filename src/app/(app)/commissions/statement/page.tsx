import Link from "next/link";
import { requireUser } from "@/lib/rbac/server";
import { getStatement } from "@/lib/commissions/queries";
import { TRIGGER_LABELS, type Trigger } from "@/lib/commissions/calc";
import { fmtDate, fmtUsd } from "@/lib/format";
import { EmptyState } from "@/components/ui/misc";
import { PrintButton } from "@/components/commissions/print-button";
import { AccrualStatusBadge } from "@/components/commissions/ledger";

export const metadata = { title: "Commission statement" };

export default async function StatementPage({ searchParams }: PageProps<"/commissions/statement">) {
  const user = await requireUser();
  const sp = await searchParams;
  const userId = typeof sp.user === "string" ? sp.user : user.id;
  const period = typeof sp.period === "string" && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : new Date().toISOString().slice(0, 7);
  const st = await getStatement(user, userId, period);
  const usd = (c: number) => fmtUsd(c, { cents: true });

  return (
    <div className="print-statement mx-auto max-w-4xl">
      <style>{`
        @media print {
          @page { margin: 14mm; }
          body * { visibility: hidden; }
          .print-statement, .print-statement * { visibility: visible; }
          .print-statement { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          .print-statement { color: #000; background: #fff; }
          .print-statement * { color: #000 !important; border-color: #bbb !important; background: transparent !important; }
        }
      `}</style>
      <div className="no-print mb-4 flex items-center justify-between">
        <Link href={`/commissions?tab=statements&period=${period}`} className="text-sm text-secondary hover:text-fg">
          ← Back to statements
        </Link>
        <PrintButton />
      </div>
      <header className="mb-6 border-b border-border pb-4">
        <p className="text-xs uppercase tracking-[0.12em] text-muted">Roundtable · Commission statement</p>
        <h1 className="mt-1 font-display text-[28px] text-fg">{st.user?.name ?? "Unknown rep"}</h1>
        <p className="text-sm text-muted">
          Period {period} · generated {fmtDate(new Date())}
        </p>
      </header>
      {st.rows.length === 0 ? (
        <EmptyState title="No accruals for this period" description="Either nothing accrued or you don't have access to this rep's statement." />
      ) : (
        <>
          <table className="table-cards w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-medium">Trigger</th>
                <th className="py-2 pr-3 font-medium">Deal</th>
                <th className="py-2 pr-3 font-medium">Detail</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {st.rows.map((r) => (
                <tr key={r.id} className="border-b border-border align-top">
                  <td data-label="Trigger" className="py-2 pr-3 text-secondary">{TRIGGER_LABELS[r.trigger as Trigger] ?? r.trigger}</td>
                  <td data-label="Deal" data-primary className="py-2 pr-3 text-body">{r.dealName ?? "—"}</td>
                  <td data-label="Detail" className="whitespace-pre-line py-2 pr-3 text-xs text-muted">{r.note}</td>
                  <td data-label="Status" className="py-2 pr-3">
                    <AccrualStatusBadge status={r.status} />
                  </td>
                  <td data-label="Amount" className="py-2 text-right tabular text-fg">{usd(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto mt-6 w-full max-w-xs space-y-1 text-sm tabular">
            <Row label="Gross" value={usd(st.totals.gross)} />
            <Row label="Clawbacks" value={usd(st.totals.clawbacks)} />
            <Row label="Net" value={usd(st.totals.net)} strong />
            <Row label="Paid" value={usd(st.totals.paid)} />
            <Row label="Approved, unpaid" value={usd(st.totals.approved)} />
            <Row label="Awaiting approval" value={usd(st.totals.accrued)} />
            {st.totals.disputed ? <Row label="Disputed" value={usd(st.totals.disputed)} /> : null}
          </dl>
        </>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between border-b border-border py-1 ${strong ? "font-medium text-fg" : "text-secondary"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
