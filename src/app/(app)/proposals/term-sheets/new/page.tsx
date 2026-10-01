import Link from "next/link";
import { can, requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getActiveTemplate, templateInfo } from "@/lib/proposals/templates";
import { termSheetDealContext, termSheetDealOptions, TERM_SHEET_PIPELINES } from "@/lib/proposals/term-sheet-queries";
import { dateSamples, snapshotOf, TERM_SHEET_KIND, usedTargets } from "@/lib/proposals/termsheet";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { TermSheetForm } from "@/components/proposals/term-sheet-form";

export const metadata = { title: "New coalition term sheet" };

export default async function NewTermSheetPage({ searchParams }: PageProps<"/proposals/term-sheets/new">) {
  const user = await requireUser();
  if (!(await can(user, "proposals", "create"))) return <EmptyState title="No access" description="Your role can't create proposals." />;
  const template = await getActiveTemplate(TERM_SHEET_KIND);
  if (!template) {
    const admin = await isAdmin(user);
    return (
      <div>
        <PageHeader title="New coalition term sheet" />
        <EmptyState
          title="No term sheet template yet"
          description={admin ? "Upload the coalition term sheet (.docx) and map its fields first." : "An admin needs to upload and activate the coalition term sheet template first."}
          action={
            admin ? (
              <Button asChild variant="primary">
                <Link href="/admin/templates">Upload template</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const sp = await searchParams;
  const dealId = typeof sp.dealId === "string" && /^[0-9a-f-]{36}$/i.test(sp.dealId) ? sp.dealId : undefined;
  const ctx = dealId ? await termSheetDealContext(user, dealId) : null;
  const eligible = ctx && TERM_SHEET_PIPELINES.includes(ctx.deal.pipelineKey);

  if (!ctx || !eligible) {
    const deals = await termSheetDealOptions(user);
    return (
      <div>
        <PageHeader title="New coalition term sheet" description="Pick the Network Development deal this term sheet is for." />
        {dealId ? <p className="mb-4 text-sm text-muted">{ctx ? "Coalition term sheets are for Network Development deals." : "That deal isn't available to you."} Pick another.</p> : null}
        {deals.length === 0 ? (
          <EmptyState title="No Network Development deals" description="You need access to a NetDev deal to create a term sheet." />
        ) : (
          <form action="/proposals/term-sheets/new" className="flex max-w-xl flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-xs text-secondary">
              <span className="mb-1 block">Deal</span>
              <NativeSelect name="dealId" required defaultValue="">
                <option value="" disabled>
                  Select a deal…
                </option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.accountName && d.accountName !== d.name ? ` · ${d.accountName}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </form>
        )}
      </div>
    );
  }

  const snap = snapshotOf(templateInfo(template));
  const targets = usedTargets(snap.fieldMap);
  return (
    <div>
      <PageHeader
        title={`Coalition term sheet · ${ctx.deal.name}`}
        description={`Template: ${template.name} (v${template.version}). Review the prefilled details, then preview and download.`}
        actions={
          <Button asChild variant="ghost">
            <Link href="/proposals/term-sheets/new">Change deal</Link>
          </Button>
        }
      />
      {!template.parsed.tiersReviewed && snap.tiers.length ? (
        <p className="mb-4 rounded-lg border border-border bg-surface-1 px-4 py-2 text-xs text-secondary">The revenue-share schedule on this template hasn&apos;t been reviewed by an admin yet. Double-check the tier.</p>
      ) : null}
      <TermSheetForm
        mode="create"
        dealId={ctx.deal.id}
        targets={targets}
        initial={{ values: Object.fromEntries(targets.map((t) => [t, ctx.prefill[t] ?? ""])), muu: ctx.muu, tierIndex: null }}
        prefill={ctx.prefill}
        usdPerMuu={ctx.usdPerMuu}
        tiers={snap.tiers}
        approval={snap.approval}
        dateSamples={dateSamples(snap.candidates, snap.fieldMap)}
      />
    </div>
  );
}
