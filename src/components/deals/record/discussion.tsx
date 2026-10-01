"use client";
import * as React from "react";
import { Loader2, MessageSquareReply, Pencil, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { deleteDealCommentAction, editDealCommentAction, postDealComment } from "@/lib/comments/actions";
import type { Thread, ThreadComment } from "@/lib/comments/core";
import { cn } from "@/lib/utils";
import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";
import { ModKey } from "@/components/ui/mod-key";

type Person = { id: string; name: string; image: string | null };

/**
 * Deal threads (V2 §C2): comments with @mentions limited to people who can see the deal, one-level replies,
 * edit / delete your own. Mentioned teammates get a notification; new comments are mirrored to Slack when configured.
 */
export function Discussion({ dealId, threads, mentionable, restricted, canComment }: { dealId: string; threads: Thread[]; mentionable: Person[]; restricted: boolean; canComment: boolean }) {
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [shown, addShown] = React.useOptimistic(threads, (list: Thread[], t: Thread) => [...list, t]);

  React.useEffect(() => {
    // Deep link from a mention notification: /deals/<id>?tab=discussion#c-<commentId>
    const id = window.location.hash.slice(1);
    if (!id.startsWith("c-")) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("bg-surface-2");
    const t = setTimeout(() => el.classList.remove("bg-surface-2"), 2000);
    return () => clearTimeout(t);
  }, []);

  return (
    <section aria-labelledby="discussion-h" className="space-y-4">
      {/* POL-11: the tab already says "Discussion" — the heading is for screen readers only. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="discussion-h" className="sr-only">
          Discussion
        </h2>
        <p className="text-[11px] text-muted">{restricted ? "Restricted deal — only people on the access list can be mentioned." : "Type @ to bring a teammate in. Only people who can see this deal are listed."}</p>
      </div>
      {canComment ? (
        <Composer
          dealId={dealId}
          people={mentionable}
          placeholder="Start a thread… what does the team need to know?"
          onOptimistic={(body) => addShown({ id: `pending-${Date.now()}`, authorId: null, authorName: "You", authorImage: null, body, createdAt: new Date().toISOString(), editedAt: null, deleted: false, mine: true, replies: [] })}
        />
      ) : null}
      {shown.length === 0 ? (
        <EmptyState title="No discussion yet" description="Questions, context and decisions about this deal live here — not in DMs." />
      ) : (
        <ol className="space-y-3">
          {[...shown].reverse().map((t) => (
            <li key={t.id} className="rounded-lg border border-border bg-surface-1">
              <CommentItem dealId={dealId} c={t} people={mentionable} onReply={canComment && !t.deleted && !t.id.startsWith("pending-") ? () => setReplyTo(replyTo === t.id ? null : t.id) : undefined} />
              {t.replies.length || replyTo === t.id ? (
                <div className="space-y-1 border-t border-border py-2 pl-10 pr-3">
                  {t.replies.map((r) => (
                    <CommentItem key={r.id} dealId={dealId} c={r} people={mentionable} compact />
                  ))}
                  {replyTo === t.id ? (
                    <div className="pt-1">
                      <Composer dealId={dealId} parentId={t.id} people={mentionable} placeholder={`Reply to ${t.authorName ?? "thread"}…`} autoFocus compact onDone={() => setReplyTo(null)} onCancel={() => setReplyTo(null)} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CommentItem({ dealId, c, people, onReply, compact }: { dealId: string; c: ThreadComment; people: Person[]; onReply?: () => void; compact?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [run, pending] = useRun();
  const [confirming, setConfirming] = React.useState(false);
  const pendingRow = c.id.startsWith("pending-");
  return (
    <article id={`c-${c.id}`} className={cn("flex gap-2.5 rounded-md transition-colors duration-200", compact ? "px-1 py-1.5" : "px-3 py-3", pendingRow ? "opacity-60" : "")}>
      <Avatar name={c.authorName} src={c.authorImage} size={compact ? 20 : 26} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
          <span className="font-medium text-secondary">{c.authorName ?? "Someone"}</span>
          <span aria-hidden>·</span>
          <RelativeTime iso={c.createdAt} />
          {c.editedAt ? <span title={`Edited ${c.editedAt}`}>· edited</span> : null}
        </p>
        {c.deleted ? (
          <p className="text-[13px] italic text-muted">Comment deleted</p>
        ) : editing ? (
          <div className="mt-1">
            <Composer dealId={dealId} editId={c.id} initial={c.body} people={people} autoFocus compact onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-body">{highlight(c.body, people)}</p>
        )}
        {!c.deleted && !editing && !pendingRow ? (
          <div className="mt-1 flex items-center gap-1 text-[11px]">
            {onReply ? (
              <button type="button" onClick={onReply} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted hover:text-fg">
                <MessageSquareReply className="size-3" aria-hidden /> Reply
              </button>
            ) : null}
            {c.mine ? (
              <>
                <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted hover:text-fg">
                  <Pencil className="size-3" aria-hidden /> Edit
                </button>
                {/* POL-11: inline two-step confirm instead of window.confirm. */}
                {confirming ? (
                  <>
                    <button
                      type="button"
                      disabled={pending}
                      autoFocus
                      onClick={() => run(() => deleteDealCommentAction({ commentId: c.id }), { success: "Comment deleted", onOk: () => setConfirming(false) })}
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-fg hover:underline"
                    >
                      <Trash2 className="size-3" aria-hidden /> Delete comment
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className="rounded px-1 py-0.5 text-muted hover:text-fg">
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={pending} onClick={() => setConfirming(true)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted hover:text-fg">
                    <Trash2 className="size-3" aria-hidden /> Delete
                  </button>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** Textarea with @mention autocomplete (keyboard: ↑ ↓ Enter/Tab to pick, Esc to close, ⌘↵ to send). */
function Composer({
  dealId,
  parentId,
  editId,
  initial = "",
  people,
  placeholder,
  autoFocus,
  compact,
  onOptimistic,
  onDone,
  onCancel,
}: {
  dealId: string;
  parentId?: string;
  editId?: string;
  initial?: string;
  people: Person[];
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
  onOptimistic?: (body: string) => void;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = React.useState(initial);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const listId = React.useId();
  const [run, pending] = useRun();
  const matches = query != null ? people.filter((u) => u.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];

  const onChange = (v: string, caret: number) => {
    setBody(v);
    const m = v.slice(0, caret).match(/(?:^|\s)@([\p{L}\p{N} .'-]{0,30})$/u);
    if (m && !m[1]!.includes("  ")) {
      setQuery(m[1]!);
      setActive(0);
    } else setQuery(null);
  };
  const pick = (u: Person) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const start = body.slice(0, caret).lastIndexOf("@");
    setBody(`${body.slice(0, start)}@${u.name} ${body.slice(caret)}`);
    setPicked((ids) => (ids.includes(u.id) ? ids : [...ids, u.id]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + u.name.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  };
  const submit = () => {
    const text = body.trim();
    if (!text || pending) return;
    if (editId) {
      run(() => editDealCommentAction({ commentId: editId, body: text, mentionIds: picked }), { success: (d) => (d.notified ? `Saved · ${d.notified} notified` : "Saved"), onOk: () => onDone?.() });
      return;
    }
    const ids = picked;
    setBody("");
    setPicked([]);
    run(
      async () => {
        onOptimistic?.(text);
        return postDealComment({ dealId, body: text, parentId, mentionIds: ids });
      },
      {
        success: (d) => (d.notified ? `Posted · ${d.notified} notified` : "Posted"),
        onOk: () => onDone?.(),
        onError: () => {
          setBody(text);
          setPicked(ids);
        },
      },
    );
  };

  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        ref={ref}
        aria-label={editId ? "Edit comment" : parentId ? "Write a reply" : "Write a comment"}
        rows={compact ? 2 : 3}
        value={body}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (query != null && matches.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + matches.length) % matches.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[active]!);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setQuery(null);
            }
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={query != null && matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={query != null && matches.length ? `${listId}-${active}` : undefined}
      />
      {query != null && matches.length ? (
        <ul id={listId} role="listbox" className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-border-strong bg-surface-2 p-1">
          {matches.map((u, i) => (
            <li key={u.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm", i === active ? "bg-surface-3 text-fg" : "text-body")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
              >
                <Avatar name={u.name} src={u.image} size={18} /> {u.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="hidden text-[11px] text-muted sm:inline">
          <ModKey then="↵" /> to {editId ? "save" : "post"}
        </span>
        <div className="ml-auto flex gap-2">
          {onCancel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" variant="primary" disabled={pending || !body.trim()}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />} {editId ? "Save" : parentId ? "Reply" : "Post"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function highlight(body: string, users: Person[]): React.ReactNode {
  const names = users.map((u) => u.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return body;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(@(?:${esc.join("|")}))`, "g");
  return body.split(re).map((part, i) => (i % 2 === 1 ? <strong key={i} className="font-medium text-fg">{part}</strong> : part));
}
