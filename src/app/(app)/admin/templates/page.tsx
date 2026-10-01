import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { listTemplates } from "@/lib/proposals/templates";
import { TEMPLATE_KINDS, templateReviewBlockers } from "@/lib/proposals/termsheet";
import { fmtDate } from "@/lib/format";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { TemplateUpload } from "@/components/proposals/template-upload";

export const metadata = { title: "Proposal templates" };

export default async function TemplatesAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden();
  const rows = await listTemplates();
  const kindLabel = (k: string) => TEMPLATE_KINDS.find((x) => x.kind === k)?.label ?? k;
  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Proposal templates</CardTitle>
            <CardDescription>
              Upload the Word template reps generate documents from. We scan it for fill-in fields and the revenue-share schedule; you confirm the mapping. The file is stored privately in the
              database, never in the code.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <TemplateUpload kinds={TEMPLATE_KINDS.map((k) => ({ kind: k.kind, label: k.label }))} />
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No templates yet" description="Upload the coalition term sheet (.docx) above. It starts as a draft: review the fields and tiers, then activate it for reps." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table-cards w-full min-w-[760px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Template</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Placeholders</th>
                <th className="px-3 py-2 font-medium">Tiers</th>
                <th className="px-3 py-2 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const mapped = t.fieldMap.filter((f) => f.input !== "ignore").length;
                const tiers = t.parsed.tiers?.length ?? 0;
                return (
                  <tr key={t.id} className="border-t border-border hover:bg-surface-1">
                    <td data-label="Template" data-primary className="px-3 py-2">
                      <div className="min-w-0">
                        <Link href={`/admin/templates/${t.id}`} className="font-medium text-fg hover:underline">
                          {t.name}
                        </Link>
                        <p className="text-[11px] text-muted">
                          {kindLabel(t.kind)} · {t.fileName}
                        </p>
                      </div>
                    </td>
                    <td data-label="Version" className="px-3 py-2 tabular text-secondary">v{t.version}</td>
                    <td data-label="Status" className="px-3 py-2">
                      {templateReviewBlockers(t).length ? <Badge>Draft — review</Badge> : t.active ? <StatusBadge status="good" label="Active" /> : <Badge>Inactive</Badge>}
                    </td>
                    <td data-label="Placeholders" className="px-3 py-2 tabular text-secondary">
                      {mapped} of {t.parsed.candidates?.length ?? 0} mapped
                    </td>
                    <td data-label="Tiers" className="px-3 py-2">
                      {tiers ? (
                        t.parsed.tiersReviewed ? (
                          <span className="tabular text-secondary">{tiers} · reviewed</span>
                        ) : (
                          <StatusBadge status="warning" label={`${tiers} · review`} />
                        )
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td data-label="Uploaded" className="px-3 py-2 tabular text-secondary">
                      {fmtDate(t.createdAt)} · {t.uploadedByName ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
