import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { audit } from "@/lib/audit";
import { getTermSheet, termSheetPreview } from "@/lib/proposals/term-sheet-queries";
import { EmptyState } from "@/components/ui/misc";
import { TermSheetDocument } from "@/components/proposals/term-sheet-document";
import { PrintButton } from "@/components/proposals/print-button";

export const metadata = { title: "Term sheet · print" };

/** Print / Save as PDF: the filled document on paper, no highlights, app chrome hidden. */
export default async function TermSheetPrintPage({ params }: PageProps<"/proposals/term-sheets/[id]/print">) {
  const user = await requireUser();
  const { id } = await params;
  const d = await getTermSheet(user, id);
  if (!d) notFound();
  if (!d.exportable) {
    return (
      <EmptyState
        title="Export blocked"
        description={d.outputs.reasons.length ? `This version needs executive approval first: ${d.outputs.reasons.join("; ")}.` : "This version can't be exported in its current status."}
        action={
          <Link href={`/proposals/term-sheets/${id}`} className="text-sm text-fg underline">
            Back to the term sheet
          </Link>
        }
      />
    );
  }
  const preview = await termSheetPreview(d.inputs);
  await audit({ actorId: user.id, action: "proposal.print_view", entity: "proposal", entityId: id, after: { version: d.proposal.version } });
  return (
    <div>
      <style>{`
        @media print {
          @page { size: letter; margin: 0.6in; }
          html, body { background: #fff !important; }
          body * { visibility: hidden; }
          .termsheet-paper, .termsheet-paper * { visibility: visible; }
          .termsheet-paper { position: absolute; left: 0; top: 0; width: 100%; max-width: none; margin: 0 !important; padding: 0 !important; border-radius: 0 !important; background: #fff !important; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/proposals/term-sheets/${id}`} className="text-sm text-secondary hover:text-fg">
          ← Back to v{d.proposal.version}
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline">For the exact Word layout, download the .docx. This prints the text.</span>
          <PrintButton />
        </div>
      </div>
      {preview.error ? <p className="text-sm text-critical">{preview.error}</p> : <TermSheetDocument body={preview.body} headers={preview.headers} footers={preview.footers} highlight={false} />}
    </div>
  );
}
