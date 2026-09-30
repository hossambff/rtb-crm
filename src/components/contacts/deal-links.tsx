"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2, Star, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/accounts/create-account-dialog";
import { linkContactToDeal, unlinkContactFromDeal } from "@/lib/contacts/actions";
import { PIPELINE_COLORS } from "@/lib/palette";

export const DEAL_ROLES = [
  { key: "decision_maker", label: "Decision maker" },
  { key: "champion", label: "Champion" },
  { key: "influencer", label: "Influencer" },
  { key: "legal", label: "Legal" },
  { key: "tech", label: "Technical" },
  { key: "finance", label: "Finance" },
  { key: "blocker", label: "Blocker" },
] as const;

export type LinkedDeal = { dealId: string; name: string; role: string | null; pipelineKey: string; pipelineColor: string; stageName: string; status: string; isPrimary: boolean };

export function DealLinks({ contactId, deals, accountDeals, canEdit }: { contactId: string; deals: LinkedDeal[]; accountDeals: { id: string; name: string; pipelineKey: string; stageName: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const linkable = accountDeals.filter((d) => !deals.some((x) => x.dealId === d.id));
  return (
    <div>
      {deals.length ? (
        <ul className="divide-y divide-border">
          {deals.map((d) => (
            <li key={d.dealId} className="flex flex-wrap items-center gap-3 py-2.5">
              <ColorTick color={d.pipelineColor || PIPELINE_COLORS[d.pipelineKey] || "#828282"} />
              <div className="min-w-0 flex-1">
                <Link href={`/deals/${d.dealId}`} className="block truncate text-sm text-fg hover:underline">
                  {d.name}
                </Link>
                <p className="text-xs text-muted">
                  {d.pipelineKey} · {d.stageName}
                </p>
              </div>
              {d.isPrimary ? (
                <Badge>
                  <Star className="size-3" /> Primary
                </Badge>
              ) : null}
              {canEdit ? (
                <RoleSelect contactId={contactId} deal={d} onDone={() => router.refresh()} />
              ) : d.role ? (
                <Badge>{DEAL_ROLES.find((r) => r.key === d.role)?.label ?? d.role}</Badge>
              ) : null}
              {canEdit ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Unlink from ${d.name}`}
                  onClick={async () => {
                    const res = await unlinkContactFromDeal({ contactId, dealId: d.dealId });
                    if (!res.ok) return toast.error(res.error);
                    toast.success("Unlinked");
                    router.refresh();
                  }}
                >
                  <Unlink />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Not on any deal" description="Link this contact to a deal with their buying-committee role." />
      )}
      {canEdit && linkable.length ? <LinkDealDialog contactId={contactId} deals={linkable} /> : null}
    </div>
  );
}

function RoleSelect({ contactId, deal, onDone }: { contactId: string; deal: LinkedDeal; onDone: () => void }) {
  return (
    <NativeSelect
      aria-label={`Role on ${deal.name}`}
      value={deal.role ?? ""}
      className="h-7 w-36 text-xs"
      onChange={async (e) => {
        const res = await linkContactToDeal({ contactId, dealId: deal.dealId, role: (e.target.value || null) as never });
        if (!res.ok) return toast.error(res.error);
        toast.success("Role updated");
        onDone();
      }}
    >
      <option value="">No role</option>
      {DEAL_ROLES.map((r) => (
        <option key={r.key} value={r.key}>
          {r.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function LinkDealDialog({ contactId, deals }: { contactId: string; deals: { id: string; name: string; pipelineKey: string; stageName: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [dealId, setDealId] = React.useState(deals[0]?.id ?? "");
  const [role, setRole] = React.useState("");
  const [primary, setPrimary] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="mt-3">
          <Link2 /> Link to deal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link to a deal</DialogTitle>
          <DialogDescription>Adds this person to the deal&apos;s stakeholder map with their buying-committee role.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Deal">
            <NativeSelect id="ld-deal" value={dealId} onChange={(e) => setDealId(e.target.value)}>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.pipelineKey} · {d.name} ({d.stageName})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Role">
            <NativeSelect id="ld-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">No role</option>
              {DEAL_ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <label className="flex items-center gap-2 text-sm text-body">
            <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} className="size-4 accent-white" /> Make primary contact
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!dealId || busy}
            onClick={async () => {
              setBusy(true);
              const res = await linkContactToDeal({ contactId, dealId, role: (role || null) as never, makePrimary: primary });
              setBusy(false);
              if (!res.ok) return toast.error(res.error);
              toast.success("Linked to deal");
              setOpen(false);
              router.refresh();
            }}
          >
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
