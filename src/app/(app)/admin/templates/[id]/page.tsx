import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { Download } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getTemplate } from "@/lib/proposals/templates";
import { TEMPLATE_KINDS, templateReviewBlockers, usedTargets } from "@/lib/proposals/termsheet";
import { INPUT_KEYS, type InputKey } from "@/lib/proposals/docx/detect";
import { fmtDate } from "@/lib/format";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TemplateMapping } from "@/components/proposals/template-mapping";
import { TierEditor } from "@/components/proposals/tier-editor";
import { TemplateActiveToggle, TemplateApprovalRules } from "@/components/proposals/template-settings";

export const metadata = { title: "Template review" };

export default async function TemplateReviewPage({ params }: PageProps<"/admin/templates/[id]">) {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden();
  const { id } = await params;
  const t = await getTemplate(id);
  if (!t) notFound();
  const readOnly = Boolean(user.impersonatedBy);
  const candidates = (t.parsed.candidates ?? []).map((c) => ({ id: c.id, kind: c.kind, text: c.text, context: c.context, occurrences: c.occurrences, suggested: c.suggested }));
  const initial = Object.fromEntries(t.fieldMap.map((f) => [f.token, f.input]));
  const mappedStd = usedTargets(t.fieldMap).filter((k): k is InputKey => (INPUT_KEYS as readonly string[]).includes(k));
  const blockers = templateReviewBlockers(t);
  const kindLabel = TEMPLATE_KINDS.find((k) => k.kind === t.kind)?.label ?? t.kind;

  return (
    <>
      <div>
        <Link href="/admin/templates" className="text-sm text-secondary hover:text-fg">
          ← Templates
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-2xl text-fg">{t.name}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-secondary">
              {t.active && !blockers.length ? <StatusBadge status="good" label="Active" /> : blockers.length ? <Badge>Draft — not visible to reps</Badge> : <Badge>Inactive</Badge>}
              <span>
                {kindLabel} · v{t.version} · {t.fileName} · uploaded {fmtDate(t.createdAt)} by {t.uploadedByName ?? "—"}
              </span>
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted" title="SHA-256 of the stored file">
              sha256 {t.sha256.slice(0, 16)}…
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={`/api/proposals/templates/${t.id}`}>
                <Download /> Original
              </a>
            </Button>
            {!readOnly ? <TemplateActiveToggle templateId={t.id} active={t.active} disabledReason={blockers[0] ?? null} /> : null}
          </div>
        </div>
      </div>

      {blockers.length ? (
        <div role="status" className="rounded-lg border border-border-strong bg-surface-1 px-4 py-3">
          <p className="text-sm text-fg">Draft — reps can&apos;t use this template until you review it and activate it.</p>
          <ul className="mt-1.5 list-inside list-disc text-xs text-secondary">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>1 · Fill-in fields</CardTitle>
            <CardDescription>
              Detected: [bracket tokens], blank ____ lines, tab blanks and written dates. Choose what fills each one; anything left as is stays exactly as in the document (signature lines
              usually should).
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <TemplateMapping templateId={t.id} candidates={candidates} initial={initial} readOnly={readOnly} reviewed={Boolean(t.parsed.mappingReviewed)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>2 · Revenue-share schedule</CardTitle>
            <CardDescription>Parsed from the document&apos;s tier table. Check every number against the document; reps see the tier that matches a deal&apos;s MUU.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <TierEditor templateId={t.id} tables={t.parsed.tierTables ?? []} tiers={t.parsed.tiers ?? []} tableIndex={t.parsed.tierTableIndex ?? null} reviewed={Boolean(t.parsed.tiersReviewed)} readOnly={readOnly} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>3 · Approval rules</CardTitle>
            <CardDescription>Term sheets that hit a rule go to an executive before they can be downloaded or marked sent.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <TemplateApprovalRules templateId={t.id} tierChange={t.parsed.approval?.tierChange ?? false} fields={t.parsed.approval?.fields ?? []} mapped={mappedStd} readOnly={readOnly} />
        </CardContent>
      </Card>

      {t.parsed.stats ? (
        <p className="text-xs text-muted tabular">
          Scanned {t.parsed.stats.paragraphs.toLocaleString("en-US")} paragraphs and {t.parsed.stats.tables} tables across {(t.parsed.parts ?? []).length} parts · {Math.round(t.parsed.stats.bytes / 1024)} KB.
          Changes apply to drafts and new versions; sent versions keep the mapping they were generated with.
        </p>
      ) : null}
    </>
  );
}
