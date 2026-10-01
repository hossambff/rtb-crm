"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookmarkMinus, BookmarkPlus, Lightbulb, Lock, Megaphone, MoreHorizontal, Quote, SmilePlus, Trash2 } from "lucide-react";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { PIPELINE_COLORS, VIZ_OTHER } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { deletePost, toggleReactionAction } from "@/lib/team/actions";
import type { FeedPost } from "@/lib/team/queries";
import { parseBody, PLAYBOOK_TAG_LABELS, REACTION_NAMES, REACTIONS, type PlaybookTag, type Reaction } from "@/lib/team/story-core";
import { PlaybookDialog } from "./playbook-dialog";

/** Hand-drawn-feeling check that draws itself once (the quiet "won" moment). Monochrome ring, status-mint tick. */
function WinMark() {
  return (
    <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-2" aria-hidden>
      <svg viewBox="0 0 24 24" className="size-5">
        <path
          d="M5 12.5l4.2 4.2L19 7"
          fill="none"
          stroke="var(--status-good)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="[stroke-dasharray:24] [stroke-dashoffset:24] motion-safe:animate-[draw_600ms_ease-out_150ms_forwards] motion-reduce:[stroke-dashoffset:0]"
        />
      </svg>
      <style href="rtb-team-draw" precedence="default">{`@keyframes draw { to { stroke-dashoffset: 0; } }`}</style>
    </span>
  );
}

function KindMark({ kind }: { kind: FeedPost["kind"] }) {
  if (kind === "win") return <WinMark />;
  const Icon = kind === "loss" ? Lightbulb : kind === "announcement" ? Megaphone : Quote;
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-secondary" aria-hidden>
      <Icon className="size-4" strokeWidth={1.5} />
    </span>
  );
}

const KIND_LABEL: Record<FeedPost["kind"], string> = { win: "Win", loss: "Lesson", announcement: "Announcement", clip: "Playbook clip" };

export function PostCard({ post, compact = false }: { post: FeedPost; compact?: boolean }) {
  const router = useRouter();
  const [reactions, setReactions] = useState(post.reactions);
  const [pending, start] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const blocks = parseBody(post.body);

  function react(emoji: Reaction) {
    setPickerOpen(false);
    // optimistic
    setReactions((prev) => {
      const cur = prev.find((r) => r.emoji === emoji);
      const next = cur
        ? prev.map((r) => (r.emoji === emoji ? { ...r, count: r.count + (r.mine ? -1 : 1), mine: !r.mine, names: r.mine ? r.names.filter((n) => n !== "You") : ["You", ...r.names] } : r))
        : [...prev, { emoji, count: 1, mine: true, names: ["You"] }];
      return next.filter((r) => r.count > 0).sort((a, b) => REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji));
    });
    start(async () => {
      const res = await toggleReactionAction({ postId: post.id, emoji });
      if (!res.ok) {
        toast.error(res.error);
        setReactions(post.reactions);
        return;
      }
      setReactions((prev) => res.data.reactions.map((r) => ({ ...r, names: prev.find((p) => p.emoji === r.emoji)?.names ?? (r.mine ? ["You"] : []) })));
    });
  }

  function remove() {
    if (!confirm("Remove this post from the team feed?")) return;
    start(async () => {
      const res = await deletePost({ postId: post.id });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Post removed.");
        router.refresh();
      }
    });
  }

  const showMenu = post.canDelete || post.canCurate;
  return (
    <article className={cn("rounded-lg border border-border bg-surface-1 transition-colors duration-150", compact ? "p-4" : "p-4 sm:p-5")} aria-labelledby={`post-${post.id}`}>
      <header className="flex items-start gap-3">
        <KindMark kind={post.kind} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {KIND_LABEL[post.kind]}
            {post.restricted ? (
              <span className="ml-2 inline-flex items-center gap-1 normal-case tracking-normal text-secondary">
                <Lock className="size-3" aria-hidden /> Restricted
              </span>
            ) : null}
          </p>
          <h3 id={`post-${post.id}`} className={cn("mt-0.5 font-display font-medium leading-snug text-fg [overflow-wrap:anywhere]", post.kind === "win" ? "text-xl" : "text-lg")}>
            {post.title}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {post.author ? (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={post.author.name} src={post.author.image} size={18} />
                <span className="text-secondary">{post.author.name}</span>
              </span>
            ) : null}
            <span aria-hidden>·</span>
            <RelativeTime value={post.createdAt} />
            {post.deal ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1.5">
                  <ColorTick color={PIPELINE_COLORS[post.deal.pipelineKey] ?? VIZ_OTHER} />
                  {post.deal.linkable ? (
                    <Link href={`/deals/${post.deal.id}`} className="text-secondary hover:text-fg hover:underline">
                      {post.deal.name}
                    </Link>
                  ) : (
                    <span className="text-secondary">{post.deal.name}</span>
                  )}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {showMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Post actions" disabled={pending}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {post.canCurate ? (
                <DropdownMenuItem onSelect={() => setPlaybookOpen(true)}>
                  {post.inPlaybook ? <BookmarkMinus /> : <BookmarkPlus />}
                  {post.inPlaybook ? "Edit playbook tags" : "Add to playbook"}
                </DropdownMenuItem>
              ) : null}
              {post.canDelete ? (
                <>
                  {post.canCurate ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem onSelect={remove}>
                    <Trash2 className="text-critical" /> Remove post
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {post.clip ? (
        <figure className="mt-4 sm:ml-12">
          <blockquote className="border-l-2 border-white/80 pl-4 font-display text-[17px] italic leading-7 text-fg [overflow-wrap:anywhere]">“{post.clip.quote}”</blockquote>
          <figcaption className="mt-2 flex flex-wrap items-center gap-2 pl-4 text-xs text-muted">
            {post.clip.speaker ? <span className="text-secondary">— {post.clip.speaker}</span> : null}
            {post.clip.at ? <span className="font-mono tabular">{post.clip.at}</span> : null}
            <Link href={`/calls/${post.clip.transcriptId}${post.clip.at ? `#t-${post.clip.at.replace(/:/g, "-")}` : ""}`} className="hover:text-fg hover:underline">
              Open call
            </Link>
          </figcaption>
        </figure>
      ) : null}

      {blocks.length ? (
        <div className={cn("mt-4 space-y-3 sm:ml-12", compact && "line-clamp-6")}>
          {blocks.map((b, i) => (
            <div key={i}>
              {b.label ? <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{b.label}</p> : null}
              <p className="whitespace-pre-line text-sm leading-6 text-body [overflow-wrap:anywhere]">{b.text}</p>
            </div>
          ))}
        </div>
      ) : null}

      {post.tags.length || post.inPlaybook ? (
        <div className="mt-3 flex flex-wrap gap-1.5 sm:ml-12">
          {post.inPlaybook && post.kind !== "clip" ? <Badge>In playbook</Badge> : null}
          {post.tags.map((t) => (
            <Badge key={t}>{PLAYBOOK_TAG_LABELS[t as PlaybookTag] ?? t}</Badge>
          ))}
        </div>
      ) : null}

      <footer className="mt-4 flex flex-wrap items-center gap-1.5 sm:ml-12">
        {reactions.map((r) => (
          <Tooltip key={r.emoji} content={`${REACTION_NAMES[r.emoji]}: ${r.names.join(", ")}${r.count > r.names.length ? ` +${r.count - r.names.length}` : ""}`}>
            <button
              type="button"
              onClick={() => react(r.emoji)}
              aria-pressed={r.mine}
              aria-label={`${REACTION_NAMES[r.emoji]} (${r.count})${r.mine ? ", you reacted" : ""}`}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-sm transition-colors duration-150",
                r.mine ? "border-white/50 bg-surface-3 text-fg" : "border-border text-secondary hover:border-border-strong hover:bg-surface-2",
              )}
            >
              <span aria-hidden>{r.emoji}</span>
              <span className="tabular text-xs">{r.count}</span>
            </button>
          </Tooltip>
        ))}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Add a reaction"
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2 text-xs text-muted transition-colors duration-150 hover:border-border-strong hover:text-fg"
            >
              <SmilePlus className="size-3.5" aria-hidden />
              {reactions.length ? null : <span>{post.kind === "win" ? "Celebrate" : "React"}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-1.5" align="start">
            <div className="flex gap-0.5" role="group" aria-label="Reactions">
              {REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => react(e)}
                  aria-label={REACTION_NAMES[e]}
                  className="flex size-9 items-center justify-center rounded-md text-lg transition-transform duration-150 hover:scale-110 hover:bg-surface-3 focus-visible:bg-surface-3 motion-reduce:hover:scale-100"
                >
                  {e}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </footer>
      {playbookOpen ? <PlaybookDialog post={post} open={playbookOpen} onOpenChange={setPlaybookOpen} /> : null}
    </article>
  );
}
