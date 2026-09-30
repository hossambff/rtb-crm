"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BadgeCheck } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { checkRegistration, registerLead } from "@/lib/commissions/actions";
import type { RegistrationConflict } from "@/lib/commissions/registration";

/**
 * "Register lead" (PRD COM-6 / ACC-8) for one known account — used on Account 360. Same server actions as the
 * Commissions → Registrations tab: conflicts are checked first, blocking conflicts disable submit, and the request
 * lands in the approver's queue (Commissions and Tasks → Approvals).
 */
export function RegisterLeadButton({ accountId, accountName, protectDays }: { accountId: string; accountName: string; protectDays: number }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [conflicts, setConflicts] = React.useState<RegistrationConflict[] | null>(null);
  const [pending, start] = React.useTransition();

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) return;
    setConflicts(null);
    start(async () => {
      const res = await checkRegistration({ accountId });
      if (!res.ok) {
        toast.error(res.error);
        setOpen(false);
        return;
      }
      setConflicts(res.data.conflicts);
    });
  };

  const submit = () =>
    start(async () => {
      const res = await registerLead({ accountId, note: note.trim() || undefined });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Registration submitted for approval");
      setOpen(false);
      setNote("");
      router.refresh();
    });

  const blocked = conflicts?.some((c) => c.severity === "block") ?? false;

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => onOpenChange(true)}>
        <BadgeCheck /> Register lead
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register {accountName}</DialogTitle>
            <DialogDescription>Approved registrations protect your ownership for {protectDays} days.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {conflicts === null ? (
              <p className="text-xs text-muted">Checking conflicts…</p>
            ) : conflicts.length === 0 ? (
              <StatusBadge status="good" label="No conflicts" />
            ) : (
              <ul className="space-y-1" aria-label="Conflicts">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    <StatusBadge status={c.severity === "block" ? "critical" : "warning"} label={c.message} />
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Label htmlFor="reg-note">Note for the approver</Label>
              <Textarea id="reg-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How you know them, who you're talking to…" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || conflicts === null || blocked} onClick={submit}>
              Submit registration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
