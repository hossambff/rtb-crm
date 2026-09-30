"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, FileDown, Send } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { fmtDate } from "@/lib/format";
import { decideProposal, markSent, newVersion } from "@/lib/proposals/actions";
import { diffInputs, type ProFormaInputs } from "@/lib/proposals/calc";

export function ProposalStatusBadge({ status }: { status: string }) {
  if (status === "approved") return <StatusBadge status="good" label="Approved" />;
  if (status === "pending_approval") return <StatusBadge status="warning" label="Pending approval" />;
  if (status === "sent" || status === "locked") return <Badge className="text-fg">Sent · locked</Badge>;
  return <Badge>Draft</Badge>;
}

export function ProposalActions(p: { id: string; status: string; exportable: boolean; canEdit: boolean; canCreate: boolean; canApprove: boolean }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "Something went wrong");
      toast.success(msg);
      after?.();
      router.refresh();
    });
  return (
    <>
      {p.status === "pending_approval" && p.canApprove ? (
        <>
          <Button
            disabled={pending}
            onClick={() => {
              const note = window.prompt("Reason for rejecting (sent to the author)?");
              if (note === null) return;
              run(() => decideProposal({ id: p.id, decision: "rejected", note: note || undefined }), "Returned to draft");
            }}
          >
            Reject
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => run(() => decideProposal({ id: p.id, decision: "approved" }), "Approved")}>
            Approve
          </Button>
        </>
      ) : null}
      {p.canCreate ? (
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await newVersion({ fromId: p.id });
              if (!res.ok) return void toast.error(res.error);
              toast.success(`Version ${res.data.version} created`);
              router.push(`/proposals/${res.data.id}`);
            })
          }
        >
          <Copy /> New version
        </Button>
      ) : null}
      {p.exportable ? (
        <Button asChild>
          <Link href={`/proposals/${p.id}/print`}>
            <FileDown /> One-pager
          </Link>
        </Button>
      ) : (
        <Button disabled title="Needs executive approval before export">
          <FileDown /> One-pager
        </Button>
      )}
      {p.canEdit && p.exportable && p.status !== "sent" ? (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Mark this version as sent? It will be locked; later changes need a new version.")) return;
            run(() => markSent({ id: p.id }), "Marked sent and locked");
          }}
        >
          <Send /> Mark sent
        </Button>
      ) : null}
    </>
  );
}

type V = { id: string; version: number; status: string; createdAt: string; createdByName: string | null; inputs: ProFormaInputs };

const fmtVal = (path: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    if (/Pct$/.test(path) || /rtbFundedPct$/.test(path)) return `${Math.round(v * 10000) / 100}%`;
    if (/(revenue\.|amount|Cost|guaranteeAmount)/.test(path)) return `$${Math.round(v / 1000).toLocaleString("en-US")}K`;
    return String(v);
  }
  return String(v);
};

/** PRO-2: diff of inputs between two versions. */
export function VersionDiff({ versions, currentId }: { versions: V[]; currentId: string }) {
  const current = versions.find((v) => v.id === currentId) ?? versions.at(-1)!;
  const prevDefault = versions.filter((v) => v.version < current.version).at(-1) ?? versions[0]!;
  const [a, setA] = React.useState(prevDefault.id);
  const [b, setB] = React.useState(current.id);
  const va = versions.find((v) => v.id === a)!;
  const vb = versions.find((v) => v.id === b)!;
  const diffs = diffInputs(va.inputs, vb.inputs);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <Link href={`/proposals/${v.id}`} className={v.id === currentId ? "font-medium text-fg" : "text-secondary hover:text-fg"}>
              Version {v.version}
            </Link>
            <ProposalStatusBadge status={v.status} />
            <span className="ml-auto text-xs text-muted">
              {v.createdByName ?? "—"} · {fmtDate(v.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      {versions.length > 1 ? (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Compare</span>
            <NativeSelect aria-label="Base version" value={a} onChange={(e) => setA(e.target.value)} className="w-32">
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </NativeSelect>
            <span className="text-muted">with</span>
            <NativeSelect aria-label="Compared version" value={b} onChange={(e) => setB(e.target.value)} className="w-32">
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </NativeSelect>
          </div>
          {diffs.length === 0 ? (
            <p className="text-sm text-muted">No input changes between these versions.</p>
          ) : (
            <table className="w-full text-xs tabular">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Field</th>
                  <th className="py-1 pr-2 text-right font-medium">v{va.version}</th>
                  <th className="py-1 text-right font-medium">v{vb.version}</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => (
                  <tr key={d.path} className="border-t border-border">
                    <td className="py-1 pr-2 text-body">{d.label}</td>
                    <td className="py-1 pr-2 text-right text-muted line-through decoration-white/30">{fmtVal(d.path, d.before)}</td>
                    <td className="py-1 text-right text-fg">{fmtVal(d.path, d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
