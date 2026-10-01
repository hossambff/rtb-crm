import Link from "next/link";
import { FileSpreadsheet, FileText, Plus } from "lucide-react";
import { getCurrentUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { dealProposals } from "@/lib/proposals/term-sheet-queries";
import { fmtDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ProposalStatusBadge } from "./proposal-controls";
import { TermSheetStatusBadge } from "./term-sheet-controls";

/**
 * Deal page slot (WS-B mounts it in "Docs & proposals"): the deal's proposals + "New term sheet" (NET) /
 * "Generate pro forma" (ENT). Does its own permission checks (proposals module, deal visibility incl. restricted
 * access lists) and renders null when not applicable.
 */
export async function DealProposals({ dealId }: { dealId: string }) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return null;
  const data = await dealProposals(user, dealId);
  if (!data) return null;
  const isNet = data.pipelineKey === "NET";
  const isEnt = data.pipelineKey === "ENT";
  if (!isNet && !isEnt && data.rows.length === 0) return null;
  const admin = isNet && !data.hasTemplate && data.canCreate ? await isAdmin(user) : false;

  return (
    <section aria-labelledby="deal-proposals-title" className="rounded-lg border border-border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 id="deal-proposals-title" className="text-sm font-medium text-fg">
          Proposals
        </h3>
        {data.canCreate ? (
          <div className="flex flex-wrap gap-2">
            {isNet && data.hasTemplate ? (
              <Button asChild size="sm" variant="primary">
                <Link href={`/proposals/term-sheets/new?dealId=${dealId}`}>
                  <Plus /> New term sheet
                </Link>
              </Button>
            ) : null}
            {isEnt ? (
              <Button asChild size="sm" variant="primary">
                <Link href={`/proposals/new?dealId=${dealId}`}>
                  <FileSpreadsheet /> Generate pro forma
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {data.rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">
          {isNet
            ? data.hasTemplate
              ? "No term sheet yet. Create one: it's prefilled from this deal."
              : admin
                ? "Upload the coalition term sheet template under Admin → Templates to generate one here."
                : "No term sheet template is active yet."
            : "No pro forma yet. Generate one: it's prefilled from this deal's terms."}
          {admin ? (
            <>
              {" "}
              <Link href="/admin/templates" className="text-fg underline underline-offset-2">
                Open templates
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.rows.map((r) => {
            const ts = r.kind === "coalition_term_sheet";
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                {ts ? <FileText className="size-4 text-muted" aria-hidden /> : <FileSpreadsheet className="size-4 text-muted" aria-hidden />}
                <Link href={ts ? `/proposals/term-sheets/${r.id}` : `/proposals/${r.id}`} className="font-medium text-fg hover:underline">
                  {ts ? "Coalition term sheet" : "Pro forma"} v{r.version}
                </Link>
                {ts ? <TermSheetStatusBadge status={r.status} /> : <ProposalStatusBadge status={r.status} />}
                <span className="text-xs text-secondary tabular">{ts ? r.label : null}</span>
                <span className="ml-auto text-xs text-muted tabular">{fmtDate(r.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
