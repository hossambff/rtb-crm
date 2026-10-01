/**
 * Deal threads (V2 §C2) — pure helpers, client-safe and unit tested.
 * One level of replies: a reply's parent must be a top-level comment. Deleted comments are soft-deleted; a deleted
 * top-level comment that still has live replies stays as a "deleted" placeholder so the thread keeps its context.
 */
import { extractMentions } from "@/lib/deals/rules";

export type CommentRow = {
  id: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string | null;
  authorImage: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type ThreadComment = Omit<CommentRow, "deletedAt" | "parentId"> & { deleted: boolean; mine: boolean };
export type Thread = ThreadComment & { replies: ThreadComment[] };

const show = (c: CommentRow, me: string): ThreadComment => ({
  id: c.id,
  authorId: c.authorId,
  authorName: c.authorName,
  authorImage: c.authorImage,
  body: c.deletedAt ? "" : c.body,
  createdAt: c.createdAt,
  editedAt: c.deletedAt ? null : c.editedAt,
  deleted: !!c.deletedAt,
  mine: !!me && c.authorId === me,
});

/**
 * Build threads (oldest first, replies oldest first). Deleted replies disappear; a deleted top-level comment is kept as
 * a placeholder only while it has live replies. Replies whose parent is missing are promoted to top level (defensive).
 */
export function buildThreads(rows: CommentRow[], me: string): Thread[] {
  const byTime = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const tops = new Map<string, Thread>();
  for (const c of byTime) if (!c.parentId) tops.set(c.id, { ...show(c, me), replies: [] });
  const orphans: Thread[] = [];
  for (const c of byTime) {
    if (!c.parentId || c.deletedAt) continue;
    const parent = tops.get(c.parentId);
    if (parent) parent.replies.push(show(c, me));
    else orphans.push({ ...show(c, me), replies: [] });
  }
  const out = [...tops.values(), ...orphans].filter((t) => !t.deleted || t.replies.length > 0);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function countLive(threads: Thread[]): number {
  return threads.reduce((n, t) => n + (t.deleted ? 0 : 1) + t.replies.length, 0);
}

/**
 * Mentioned user ids for a comment: "@Full Name" matches against the allowed audience, plus explicitly picked ids that
 * are in the audience AND whose "@Name" is still in the body (a picked-then-deleted mention doesn't notify).
 */
export function resolveMentions(body: string, audience: { id: string; name: string }[], picked: string[] = []): string[] {
  const found = new Set(extractMentions(body, audience));
  const lower = body.toLowerCase();
  for (const id of picked) {
    const u = audience.find((a) => a.id === id);
    if (u && lower.includes(`@${u.name.toLowerCase()}`)) found.add(u.id);
  }
  return [...found];
}

/** Users newly mentioned by an edit (only they get a notification). */
export function newMentions(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((id) => !had.has(id));
}
