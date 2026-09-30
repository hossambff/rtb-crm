"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DealPicker, type PickedDeal } from "@/components/inbox/deal-picker";
import { attachTranscriptDeal, reanalyzeTranscript } from "@/lib/transcripts/actions";
import { syncGranolaNow } from "@/lib/integrations/actions";

/** Polls while analysis is pending/processing (CALL-6 runs right after upload). */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}

export function ReanalyzeTranscriptButton({ id, label = "Re-run analysis" }: { id: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await reanalyzeTranscript({ id });
          if (!r.ok) toast.error(r.error);
          else {
            toast.success(`Analysis updated (${r.data.engine === "heuristic" ? "heuristic" : "AI"}).`);
            router.refresh();
          }
        })
      }
    >
      <Sparkles /> {pending ? "Analyzing…" : label}
    </Button>
  );
}

export function AttachDeal({ id, deal }: { id: string; deal: { id: string; name: string } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedDeal | null>(null);
  const [pending, start] = useTransition();
  const save = (dealId: string | null) =>
    start(async () => {
      const r = await attachTranscriptDeal({ id, dealId });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(dealId ? "Deal attached." : "Deal detached.");
        setOpen(false);
        router.refresh();
      }
    });
  return (
    <>
      <Button size="sm" variant={deal ? "ghost" : "secondary"} onClick={() => setOpen(true)}>
        <Link2 /> {deal ? "Change deal" : "Attach deal"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deal ? "Change deal" : "Attach to a deal"}</DialogTitle>
            <DialogDescription>The call is logged on the deal timeline and field/stage updates apply to it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DealPicker value={picked} onChange={setPicked} />
          </DialogBody>
          <DialogFooter>
            {deal ? (
              <Button variant="ghost" size="sm" className="mr-auto" disabled={pending} onClick={() => save(null)}>
                Detach
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!picked || pending} onClick={() => picked && save(picked.id)}>
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GranolaSyncButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await syncGranolaNow({});
          if (!r.ok) toast.error(r.error);
          else {
            toast.success(`Granola: ${r.data.ingested} new, ${r.data.updated} updated.`);
            router.refresh();
          }
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : undefined} /> Sync Granola
    </Button>
  );
}
