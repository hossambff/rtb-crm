"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { postAnnouncement } from "@/lib/team/actions";

export function AnnouncementComposer({ slackReady = false }: { /** QA MIN-38 */ slackReady?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [slack, setSlack] = useState(false);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await postAnnouncement({ title, body, slack: slackReady && slack });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Announcement posted.");
      setOpen(false);
      setTitle("");
      setBody("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Megaphone /> Announce
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post an announcement</DialogTitle>
          <DialogDescription>Shows in everyone&apos;s team feed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody>
            <div className="space-y-1.5">
              <Label htmlFor="ann-title">Headline</Label>
              <Input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required minLength={3} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-body">Details</Label>
              <Textarea id="ann-body" value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} />
            </div>
            {slackReady ? (
              <label className="flex items-center gap-2 text-sm text-body">
                <input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} className="size-4 accent-white" />
                Also post to Slack
              </label>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || title.trim().length < 3}>
              {pending ? "Posting…" : "Post"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
