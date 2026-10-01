"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setPlaybook } from "@/lib/team/actions";
import type { FeedPost } from "@/lib/team/queries";
import { PLAYBOOK_TAGS, type PlaybookTag } from "@/lib/team/story-core";
import { TagPicker } from "./tag-picker";

/** Add a story/announcement to the playbook (with tags), edit its tags, or take it out. */
export function PlaybookDialog({ post, open, onOpenChange }: { post: FeedPost; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [tags, setTags] = useState<PlaybookTag[]>(post.tags.filter((t): t is PlaybookTag => (PLAYBOOK_TAGS as readonly string[]).includes(t)));
  const [pending, start] = useTransition();

  function save(inPlaybook: boolean) {
    start(async () => {
      const res = await setPlaybook({ postId: post.id, inPlaybook, tags });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(inPlaybook ? "Saved to the playbook." : "Removed from the playbook.");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{post.inPlaybook ? "Playbook tags" : "Add to playbook"}</DialogTitle>
          <DialogDescription>Tag it so reps find it when they hit the same moment.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <TagPicker value={tags} onChange={setTags} />
        </DialogBody>
        <DialogFooter className="flex-wrap">
          {post.inPlaybook ? (
            <Button variant="ghost" className="mr-auto" disabled={pending} onClick={() => save(false)}>
              Remove from playbook
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save(true)} disabled={pending || tags.length === 0}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
