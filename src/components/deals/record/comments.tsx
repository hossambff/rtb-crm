"use client";
import * as React from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { addComment } from "@/lib/deals/actions";

import type { UserLite } from "@/lib/deals/types";
import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";

type Comment = { id: string; body: string; createdAt: string; authorName: string | null; authorImage: string | null };

/** CARD-10 comments with @mention autocomplete; mentioned users get a notification (access-list aware server-side). */
export function Comments({ dealId, comments, users }: { dealId: string; comments: Comment[]; users: UserLite[] }) {
  const [body, setBody] = React.useState("");
  const [mentionIds, setMentionIds] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [run, pending] = useRun();

  const matches = query != null ? users.filter((u) => u.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];

  const onChange = (v: string, caret: number) => {
    setBody(v);
    const upto = v.slice(0, caret);
    const m = upto.match(/(?:^|\s)@([\p{L}\p{N} .'-]{0,30})$/u);
    if (m && !m[1]!.includes("  ")) {
      setQuery(m[1]!);
      setActive(0);
    } else setQuery(null);
  };

  const pick = (u: UserLite) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const upto = body.slice(0, caret);
    const start = upto.lastIndexOf("@");
    const next = `${body.slice(0, start)}@${u.name} ${body.slice(caret)}`;
    setBody(next);
    setMentionIds((ids) => (ids.includes(u.id) ? ids : [...ids, u.id]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + u.name.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = () => {
    if (!body.trim()) return;
    run(() => addComment({ dealId, body: body.trim(), mentionIds }), {
      success: (d) => (d.notified ? `Comment posted · ${d.notified} notified` : "Comment posted"),
      onOk: () => {
        setBody("");
        setMentionIds([]);
      },
    });
  };

  return (
    <section id="comments" aria-labelledby="comments-h" className="rounded-lg border border-border bg-surface-1">
      <div className="border-b border-border px-4 py-3">
        <h2 id="comments-h" className="font-display text-lg text-fg">
          Comments <span className="font-sans text-xs text-muted tabular">{comments.length}</span>
        </h2>
      </div>
      {comments.length ? (
        <ul className="space-y-3 px-4 py-3">
          {comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.authorName} src={c.authorImage} size={24} />
              <div className="min-w-0">
                <p className="text-[11px] text-muted">
                  <span className="font-medium text-secondary">{c.authorName ?? "Someone"}</span> · <RelativeTime iso={c.createdAt} />
                </p>
                <p className="whitespace-pre-wrap text-[13px] text-body">{highlight(c.body, users)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="relative border-t border-border px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          ref={ref}
          aria-label="Write a comment"
          rows={2}
          value={body}
          placeholder="Comment… type @ to mention a teammate"
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
              } else if (e.key === "Escape") setQuery(null);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          aria-autocomplete="list"
          aria-expanded={query != null && matches.length > 0}
          aria-controls="mention-list"
        />
        {query != null && matches.length ? (
          <ul id="mention-list" role="listbox" className="absolute bottom-full left-4 z-20 mb-1 w-64 rounded-md border border-border-strong bg-surface-2 p-1">
            {matches.map((u, i) => (
              <li key={u.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${i === active ? "bg-surface-3 text-fg" : "text-body"}`}
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
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted">⌘↵ to post</span>
          <Button type="submit" size="sm" variant="primary" disabled={pending || !body.trim()}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />} Post
          </Button>
        </div>
      </form>
    </section>
  );
}

function highlight(body: string, users: UserLite[]): React.ReactNode {
  const names = users.map((u) => u.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return body;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(@(?:${esc.join("|")}))`, "g");
  return body.split(re).map((part, i) => (i % 2 === 1 ? <strong key={i} className="font-medium text-fg">{part}</strong> : part));
}
