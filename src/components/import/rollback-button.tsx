"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { rollbackImport } from "@/lib/import/actions";

export function RollbackButton({ batchId, label, size = "sm" }: { batchId: string; label: string; size?: "sm" | "md" }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size={size}>
          <Undo2 /> Roll back
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roll back this import?</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="list-disc space-y-1 pl-5 text-sm text-secondary">
            <li>Accounts, deals and contacts it created are archived (soft-deleted).</li>
            <li>Notes, audience metrics, splits and stakeholder links it created are removed.</li>
            <li>Fields it filled on existing records are restored to their previous values.</li>
          </ul>
          <p className="text-xs text-muted">The rollback is audit-logged. Placeholder users are kept.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const res = await rollbackImport({ batchId });
              setBusy(false);
              if (!res.ok) return toast.error(res.error);
              toast.success(`Rolled back — ${res.data.removed} rows removed, ${res.data.restored} restored`);
              setOpen(false);
              router.refresh();
            }}
          >
            {busy ? "Rolling back…" : "Roll back import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
