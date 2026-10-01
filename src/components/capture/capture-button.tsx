"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PickedDeal } from "@/components/inbox/deal-picker";
import { captureContext } from "@/lib/capture/actions";
import { CaptureForm } from "./capture-form";

type Ctx = { allowed: boolean; target: PickedDeal | null };

/**
 * V2 A10 global "Capture" button for the topbar. Desktop: a dialog; phones (< 640 px): the full-screen /capture page,
 * which is easier to dictate into. Mount once in the topbar: <CaptureButton />.
 * QA MIN-12: hidden for roles that can't log activities, and deal/account-aware — on /deals/:id or /accounts/:id it
 * opens pre-targeted on that record.
 */
export function CaptureButton({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);

  useEffect(() => {
    let live = true;
    void captureContext({ path: pathname ?? "" }).then((r) => {
      if (!live || !r.ok) return;
      const t = r.data.target;
      setCtx({ allowed: r.data.allowed, target: t ? { id: t.id, name: t.name, kind: t.kind, subtitle: t.kind === "deal" ? "Deal" : "Account" } : null });
    });
    return () => {
      live = false;
    };
  }, [pathname]);

  if (ctx && !ctx.allowed) return null;
  const target = ctx?.target ?? null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={target ? `Quick capture for ${target.name}` : "Quick capture"}
        title="Quick capture — dictate or type a note, tasks and next step"
        onClick={() => {
          if (window.matchMedia("(max-width: 639px)").matches) router.push(target?.kind === "deal" ? `/capture?dealId=${target.id}` : "/capture");
          else setOpen(true);
        }}
      >
        <NotebookPen strokeWidth={1.5} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Quick capture</DialogTitle>
            <DialogDescription>Dictate or type what happened — review the note, tasks and next step before anything is saved.</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4">{open ? <CaptureForm onDone={() => setOpen(false)} initialTarget={target} /> : null}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
