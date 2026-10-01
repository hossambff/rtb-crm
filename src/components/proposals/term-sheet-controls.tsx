"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, FileDown, PenLine, Printer, Send, Signature } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { decideProposal } from "@/lib/proposals/actions";
import { newTermSheetVersion, setTermSheetStatus } from "@/lib/proposals/term-sheet-actions";

export function TermSheetStatusBadge({ status }: { status: string }) {
  if (status === "signed") return <StatusBadge status="good" label="Signed" />;
  if (status === "approved") return <StatusBadge status="good" label="Approved" />;
  if (status === "pending_approval") return <StatusBadge status="warning" label="Pending approval" />;
  if (status === "sent" || status === "locked") return <Badge className="text-fg">Sent · locked</Badge>;
  return <Badge>Draft</Badge>;
}

type Props = {
  id: string;
  version: number;
  status: string;
  exportable: boolean;
  today: string;
  perms: { canEdit: boolean; canCreate: boolean; canApprove: boolean };
};

export function TermSheetActions(p: Props) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [dialog, setDialog] = React.useState<null | "sent" | "signed" | "reject">(null);
  const [date, setDate] = React.useState(p.today);
  const [note, setNote] = React.useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "Something went wrong");
      toast.success(msg);
      setDialog(null);
      router.refresh();
    });

  return (
    <>
      {p.status === "pending_approval" && p.perms.canApprove ? (
        <>
          <Button disabled={pending} onClick={() => setDialog("reject")}>
            Reject
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => run(() => decideProposal({ id: p.id, decision: "approved" }), "Approved")}>
            Approve
          </Button>
        </>
      ) : null}
      {p.exportable ? (
        <>
          <Button asChild>
            <a href={`/api/proposals/${p.id}/docx`} download>
              <FileDown /> Download .docx
            </a>
          </Button>
          <Button asChild variant="ghost">
            <Link href={`/proposals/term-sheets/${p.id}/print`}>
              <Printer /> Print / PDF
            </Link>
          </Button>
        </>
      ) : (
        <Button disabled title="Needs executive approval before export">
          <FileDown /> Download .docx
        </Button>
      )}
      {p.perms.canCreate ? (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await newTermSheetVersion({ fromId: p.id });
              if (!res.ok) return void toast.error(res.error);
              toast.success(`Version ${res.data.version} created`);
              router.push(`/proposals/term-sheets/${res.data.id}`);
            })
          }
        >
          <Copy /> New version
        </Button>
      ) : null}
      {p.perms.canEdit && p.exportable && (p.status === "draft" || p.status === "approved") ? (
        <Button variant="primary" disabled={pending} onClick={() => setDialog("sent")}>
          <Send /> Mark sent
        </Button>
      ) : null}
      {p.perms.canEdit && p.status === "sent" ? (
        <Button variant="primary" disabled={pending} onClick={() => setDialog("signed")}>
          <Signature /> Mark signed
        </Button>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "sent" ? `Mark v${p.version} as sent` : dialog === "signed" ? `Record the signature on v${p.version}` : `Reject v${p.version}`}</DialogTitle>
            <DialogDescription>
              {dialog === "sent"
                ? "Locks this version. Later changes need a new version. Logged on the deal."
                : dialog === "signed"
                  ? "Signatures are collected outside the app; record the date the partner signed. Logged on the deal."
                  : "Returns the version to draft. The reason is sent to the author."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {dialog === "reject" ? (
              <div className="space-y-1">
                <Label htmlFor="ts-reject">Reason</Label>
                <Textarea id="ts-reject" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="ts-date">{dialog === "sent" ? "Sent on" : "Signed on"}</Label>
                <Input id="ts-date" type="date" max={p.today} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            {dialog === "reject" ? (
              <Button variant="primary" disabled={pending || !note.trim()} onClick={() => run(() => decideProposal({ id: p.id, decision: "rejected", note: note.trim() }), "Returned to draft")}>
                Reject
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={pending || !date}
                onClick={() => run(() => setTermSheetStatus({ id: p.id, status: dialog === "signed" ? "signed" : "sent", date }), dialog === "signed" ? "Signature recorded" : "Marked sent and locked")}
              >
                {dialog === "signed" ? <Signature /> : <Send />} Confirm
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Collapsible "Edit inputs" area for draft versions. */
export function TermSheetEditToggle({ children, defaultOpen = false }: { children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <Button variant={open ? "ghost" : "secondary"} size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <PenLine /> {open ? "Close editor" : "Edit inputs"}
      </Button>
      {open ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
