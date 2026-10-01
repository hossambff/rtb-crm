"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { applyDealSignal, dismissDealSignal } from "@/lib/signals/actions";

/** Apply / Dismiss for one deal signal. Gate failures come back as the stage service's message (e.g. missing fields). */
export function SignalActions({ id, dealId, label, confirm }: { id: string; dealId: string; label: string; confirm: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function run(kind: "apply" | "dismiss") {
    if (kind === "apply" && confirm && !window.confirm(confirm)) return;
    start(async () => {
      const r = kind === "apply" ? await applyDealSignal({ id, dealId }) : await dismissDealSignal({ id, dealId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (kind === "apply" && typeof r.data === "object" && r.data.status === "needs_input") {
        // CR M9: the move needs a next step / required fields — open the deal's move dialog, prefilled
        toast.message(r.data.message);
        router.push(r.data.href);
        return;
      }
      toast.success(kind === "apply" && typeof r.data === "object" ? r.data.message : "Signal dismissed.");
      router.refresh();
    });
  }
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" variant="primary" disabled={pending} onClick={() => run("apply")} className="max-w-[16rem]" title={label}>
        <Check /> <span className="truncate">{label}</span>
      </Button>
      <Button size="icon-sm" variant="ghost" disabled={pending} onClick={() => run("dismiss")} aria-label="Dismiss signal" title="Dismiss">
        <X />
      </Button>
    </div>
  );
}
