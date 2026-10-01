import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { getTermSheet, termSheetPreview, todayIso } from "@/lib/proposals/term-sheet-queries";
import { dateSamples, termSheetEconomics, termSheetLocked } from "@/lib/proposals/termsheet";
import { targetLabel } from "@/lib/proposals/docx/detect";
import { fmtDate } from "@/lib/format";
import { StatusBadge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/misc";
import { PartnerEconomics } from "@/components/proposals/partner-economics";
import { TermSheetDocument } from "@/components/proposals/term-sheet-document";
import { TermSheetForm } from "@/components/proposals/term-sheet-form";
import { TermSheetActions, TermSheetEditToggle, TermSheetStatusBadge } from "@/components/proposals/term-sheet-controls";
import { showTokenText } from "@/components/proposals/show-token";

const load = cache(async (id: string) => getTermSheet(await requireUser(), id));

export async function generateMetadata({ params }: PageProps<"/proposals/term-sheets/[id]">) {
  const d = await load((await params).id);
  return { title: d ? `${d.deal.name} v${d.proposal.version} · Term sheet` : "Term sheet" };
}

export default async function TermSheetPage({ params }: PageProps<"/proposals/term-sheets/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const d = await load(id);
  if (!d) notFound();
  const preview = await termSheetPreview(d.inputs);
  const locked = termSheetLocked(d.proposal.status);
  const econ = termSheetEconomics(d.inputs, d.inputs.snapshot.tiers);
  const labels = Object.fromEntries(d.targets.map((t) => [t, targetLabel(t)]));
  const snap = d.inputs.snapshot;

  return (
    <div>
      <Link href={`/deals/${d.deal.id}`} className="-my-1.5 mb-0.5 inline-block py-1.5 text-sm text-secondary hover:text-fg">
        ← {d.deal.name}
      </Link>
      <PageHeader
        title={`Coalition term sheet · v${d.proposal.version}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <TermSheetStatusBadge status={d.proposal.status} />
            <span>
              {d.deal.accountName ?? d.deal.name} · created {fmtDate(d.proposal.createdAt)}
              {d.proposal.sentAt ? ` · sent ${fmtDate(d.proposal.sentAt)}` : ""}
              {d.proposal.signedAt ? ` · signed ${fmtDate(d.proposal.signedAt)}` : ""}
            </span>
          </span>
        }
        actions={<TermSheetActions id={d.proposal.id} version={d.proposal.version} status={d.proposal.status} exportable={d.exportable} today={todayIso(user.timezone)} perms={d.perms} />}
      />

      {d.proposal.status === "draft" && d.proposal.approvalReason?.startsWith("Rejected") ? (
        <div className="mb-4">
          <StatusBadge status="critical" label={d.proposal.approvalReason} />
        </div>
      ) : null}
      {d.proposal.status === "pending_approval" ? (
        <div className="mb-4 rounded-lg border border-border bg-surface-1 px-4 py-3 text-sm">
          <StatusBadge status="warning" label="Waiting for executive approval" />
          <ul className="mt-1.5 list-inside list-disc text-xs text-secondary">
            {d.outputs.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!locked && d.perms.canEdit ? (
        <div className="mb-6">
          <TermSheetEditToggle>
            <TermSheetForm
              mode="edit"
              dealId={d.deal.id}
              proposalId={d.proposal.id}
              targets={d.targets}
              initial={{ values: d.inputs.values, muu: d.inputs.muu, tierIndex: d.inputs.tierIndex, notes: d.inputs.notes }}
              prefill={d.inputs.prefill}
              usdPerMuu={d.inputs.usdPerMuu}
              tiers={snap.tiers}
              approval={snap.approval}
              dateSamples={dateSamples(snap.candidates, snap.fieldMap)}
            />
          </TermSheetEditToggle>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 rounded-lg border border-border bg-surface-1 p-3 sm:p-6">
          {preview.error ? (
            <p className="p-6 text-sm text-critical">{preview.error}</p>
          ) : (
            <TermSheetDocument body={preview.body} headers={preview.headers} footers={preview.footers} labels={labels} />
          )}
          <p className="mt-3 text-center text-[11px] text-muted">
            Preview of the text. The .docx keeps the template&apos;s exact layout, fonts and images. <mark className="rounded-sm bg-[#fde9a6] px-1 text-black">Highlighted</mark> = filled in.
          </p>
        </div>

        <aside className="order-first space-y-4 lg:sticky lg:top-20 lg:order-none lg:self-start">
          <PartnerEconomics e={econ} tiers={snap.tiers} />

          {d.outputs.unfilled.length ? (
            <section className="rounded-lg border border-border p-4">
              <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Still blank</h3>
              <ul className="mt-2 space-y-1 text-xs text-secondary">
                {d.outputs.unfilled.slice(0, 12).map((u, i) => (
                  <li key={`${u.token}-${i}`}>
                    {targetLabel(u.target)} <span className="font-mono text-muted">{showTokenText(u.token)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="rounded-lg border border-border p-4">
            <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Versions</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {d.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/proposals/term-sheets/${v.id}`} className={v.id === d.proposal.id ? "font-medium text-fg" : "text-secondary hover:text-fg"}>
                    v{v.version}
                  </Link>
                  <TermSheetStatusBadge status={v.status} />
                  <span className="ml-auto text-[11px] text-muted">
                    {v.createdByName ?? "—"} · {fmtDate(v.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-muted">
              Template {d.template ? `${d.template.name} v${d.template.version}${d.template.active ? "" : " (no longer active)"}` : "unavailable"}
            </p>
          </section>

          {d.approvals.length ? (
            <section className="rounded-lg border border-border p-4">
              <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Approvals</h3>
              <ul className="mt-2 space-y-2 text-xs">
                {d.approvals.map((a) => (
                  <li key={a.id}>
                    <span className="text-fg">{a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : a.status === "pending" ? "Pending" : a.status}</span>
                    <span className="text-muted">
                      {" "}
                      · requested by {a.requestedByName ?? "—"} {fmtDate(a.createdAt)}
                      {a.decidedAt ? ` · decided ${fmtDate(a.decidedAt)}` : ""}
                    </span>
                    {a.note ? <p className="text-secondary">“{a.note}”</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {d.inputs.notes ? (
            <section className="rounded-lg border border-border p-4">
              <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Internal notes</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-body">{d.inputs.notes}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
