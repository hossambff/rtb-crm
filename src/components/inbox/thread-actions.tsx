"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Link2Off, Lock, LockOpen, Reply } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { linkThreadToDeal, setThreadPrivate } from "@/lib/gmail/actions";
import { DealPicker, type PickedDeal } from "./deal-picker";
import { EmailComposer } from "./email-composer";

export function ThreadActions({
  threadId,
  dealId,
  isPrivate,
  isOwn,
  suggestedDeal,
  reply,
}: {
  threadId: string;
  dealId: string | null;
  isPrivate: boolean;
  isOwn: boolean;
  suggestedDeal: { id: string; name: string } | null;
  reply: { to: string[]; canSend: boolean };
}) {
  const router = useRouter();
  const [linkOpen, setLinkOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [deal, setDeal] = useState<PickedDeal | null>(null);
  const [pending, start] = useTransition();

  if (!isOwn) return <p className="text-xs text-muted">Read-only: this thread is in a teammate&apos;s mailbox and shown because it&apos;s linked to a deal you can see.</p>;

  const link = (id: string | null, label: string) =>
    start(async () => {
      const r = await linkThreadToDeal({ threadId, dealId: id });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(label);
        setLinkOpen(false);
        setDeal(null);
        router.refresh();
      }
    });

  return (
    <div className="space-y-3">
      {!dealId && suggestedDeal && !isPrivate ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong px-3 py-2 text-xs">
          <span className="text-secondary">
            Suggested deal: <span className="text-fg">{suggestedDeal.name}</span>
          </span>
          <Button size="sm" variant="secondary" className="ml-auto h-7" disabled={pending} onClick={() => link(suggestedDeal.id, `Linked to ${suggestedDeal.name}.`)}>
            Link
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!isPrivate ? (
          <Button size="sm" variant="primary" onClick={() => setReplyOpen((v) => !v)} aria-expanded={replyOpen}>
            <Reply /> Reply
          </Button>
        ) : null}
        {!isPrivate ? (
          dealId ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setLinkOpen(true)}>
                <Link2 /> Change deal
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => link(null, "Unlinked from deal.")}>
                <Link2Off /> Unlink
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setLinkOpen(true)}>
              <Link2 /> Link to deal
            </Button>
          )
        ) : null}
        {isPrivate ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await setThreadPrivate({ threadId, private: false });
                if (!r.ok) toast.error(r.error);
                else {
                  toast.success("Thread will be logged again from new messages on.");
                  router.refresh();
                }
              })
            }
          >
            <LockOpen /> Stop keeping private
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setPrivateOpen(true)}>
            <Lock /> Mark private
          </Button>
        )}
      </div>

      {replyOpen && !isPrivate ? (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <EmailComposer threadId={threadId} dealId={dealId} defaultTo={reply.to} canSend={reply.canSend} submitLabel="Send reply" onCancel={() => setReplyOpen(false)} onSent={() => {
            setReplyOpen(false);
            router.refresh();
          }} />
        </div>
      ) : null}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link thread to a deal</DialogTitle>
            <DialogDescription>Past and future messages in this thread are logged on the deal&apos;s timeline.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DealPicker value={deal} onChange={setDeal} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!deal || pending} onClick={() => deal && link(deal.id, `Linked to ${deal.name}.`)}>
              Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={privateOpen} onOpenChange={setPrivateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this thread private?</DialogTitle>
            <DialogDescription>
              Its logged activities are deleted, stored bodies and AI analysis are removed, open AI tasks from it are cancelled, and new messages won&apos;t
              be logged. Nobody else will see it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPrivateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await setThreadPrivate({ threadId, private: true });
                  if (!r.ok) toast.error(r.error);
                  else {
                    toast.success("Thread marked private.");
                    setPrivateOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              <Lock /> Mark private
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
