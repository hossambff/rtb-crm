"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { draftStoryWithAi, postStory } from "@/lib/team/actions";
import type { StoryComposerData } from "@/lib/team/queries";
import { STORY_SECTION_LABELS, type StoryDraft } from "@/lib/team/story-core";

const PLACEHOLDERS = {
  win: {
    whatWorked: "The angle, the champion, the reference, the coalition offer — what tipped it?",
    objection: "“We already have an ad stack” → how you answered it",
    timeline: "How long it took and the moments that mattered",
  },
  loss: {
    whatWorked: "Looking back, what would you change — earlier, later, differently?",
    objection: "The objection we couldn't get past",
    timeline: "How long it ran and where it stalled",
  },
} as const;

/** "Share the story" composer (opened from the Today item or /team?share=<dealId>). */
export function StoryComposer({ data, aiEnabled, slackReady = false }: { data: StoryComposerData; aiEnabled: boolean; /** QA MIN-38 */ slackReady?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<StoryDraft>(data.draft);
  const [engine, setEngine] = useState(data.engine);
  const [slack, setSlack] = useState(slackReady && data.status === "won" && !data.restricted);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [aiPending, startAi] = useTransition();
  const kind = draft.kind;
  const labels = STORY_SECTION_LABELS[kind];

  function close() {
    setOpen(false);
    router.replace("/team", { scroll: false });
  }

  function rewrite() {
    startAi(async () => {
      const res = await draftStoryWithAi({ dealId: data.dealId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (!res.data.ai) toast.message("Copilot is unavailable right now — kept the facts-only draft.");
      setDraft(res.data.draft);
      setEngine(res.data.engine);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await postStory({ dealId: data.dealId, title: draft.title, whatWorked: draft.whatWorked, objection: draft.objection, timeline: draft.timeline, slack: slackReady && slack });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.data.slack ? "Story shared with the team and posted to Slack." : "Story shared with the team.");
      setOpen(false);
      router.replace("/team", { scroll: false });
      router.refresh();
    });
  }

  const set = (k: keyof StoryDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{kind === "win" ? "Share the win" : "Share the lesson"}</DialogTitle>
          <DialogDescription>
            {data.dealName} · {data.pipelineKey}. {kind === "win" ? "Tell the team what worked so the next rep can reuse it." : "Losses teach the most — what should the next rep know?"}
          </DialogDescription>
        </DialogHeader>
        {data.alreadyShared ? (
          <DialogBody>
            <p className="text-sm text-body">This story was already shared.</p>
            <Link href="/team" className="text-sm text-fg underline-offset-4 hover:underline" onClick={close}>
              See it in the feed
            </Link>
          </DialogBody>
        ) : !data.canPost ? (
          <DialogBody>
            <p className="text-sm text-body">Only the deal team can share this story.</p>
          </DialogBody>
        ) : (
          <form onSubmit={submit}>
            <DialogBody>
              {data.restricted ? (
                <p className="flex items-start gap-2 rounded-md border border-border-strong bg-surface-1 px-3 py-2 text-xs text-secondary">
                  <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Restricted deal — the story is visible only to people on its access list and never posted to Slack.
                </p>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="story-title">Headline</Label>
                <Input id="story-title" value={draft.title} onChange={set("title")} maxLength={140} required aria-invalid={Boolean(errors.title)} />
                {errors.title ? <p className="text-xs text-critical">{errors.title[0]}</p> : null}
              </div>
              {(["whatWorked", "objection", "timeline"] as const).map((k) => (
                <div key={k} className="space-y-1.5">
                  <Label htmlFor={`story-${k}`}>{labels[k]}</Label>
                  <Textarea id={`story-${k}`} value={draft[k]} onChange={set(k)} rows={k === "whatWorked" ? 4 : 3} maxLength={k === "whatWorked" ? 1500 : 1000} placeholder={PLACEHOLDERS[kind][k]} />
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>{engine === "heuristic" ? "Prefilled from the deal's history — edit freely." : "Drafted by Copilot from the deal's history — check it before posting."}</span>
                {aiEnabled ? (
                  <Button type="button" variant="ghost" size="sm" onClick={rewrite} disabled={aiPending || pending}>
                    <Sparkles /> {aiPending ? "Drafting…" : "Rewrite with Copilot"}
                  </Button>
                ) : null}
              </div>
              {!data.restricted && slackReady ? (
                <label className="flex items-center gap-2 text-sm text-body">
                  <input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} className="size-4 accent-white" />
                  Also post to the team&apos;s Slack channel
                </label>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close} disabled={pending}>
                Not now
              </Button>
              <Button type="submit" variant="primary" disabled={pending || aiPending}>
                {pending ? "Sharing…" : "Share with the team"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
