"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { addPlaybookClip } from "@/lib/team/actions";
import type { PlaybookTag } from "@/lib/team/story-core";
import { TagPicker } from "./tag-picker";

type Picked = { quote: string; at: string | null; speaker: string | null };

const TS_ID = /^t-(\d{2})-(\d{2})-(\d{2})$/;

/** Line metadata from the transcript viewer's DOM: `data-ts` / `data-speaker` when present, else the `t-hh-mm-ss` anchor id. */
function lineMeta(node: Node | null, root: HTMLElement): { at: string | null; speaker: string | null } {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && el !== root && el.tagName !== "LI" && !el.dataset.ts) el = el.parentElement;
  if (!el || el === root) return { at: null, speaker: null };
  const m = TS_ID.exec(el.id);
  const at = el.dataset.ts ?? (m ? `${m[1]}:${m[2]}:${m[3]}` : null);
  const speaker = el.dataset.speaker ?? el.querySelector<HTMLElement>("[data-speaker], span.font-medium")?.textContent?.trim() ?? null;
  return { at, speaker: speaker || null };
}

/**
 * Text of the selection restricted to transcript line bodies (`[data-clip-text]`, else `li > p`), so timestamps and
 * speaker labels from multi-line selections don't end up in the quote. Falls back to the raw selection text.
 */
function selectedText(range: Range, root: HTMLElement): string {
  const lines = Array.from(root.querySelectorAll<HTMLElement>("[data-clip-text], li > p"));
  const parts: string[] = [];
  for (const p of lines) {
    if (!range.intersectsNode(p)) continue;
    const r = document.createRange();
    r.selectNodeContents(p);
    if (p.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset);
    if (p.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset);
    const t = r.toString().trim();
    if (t) parts.push(t);
  }
  return (parts.length ? parts.join(" ") : range.toString()).replace(/\s+/g, " ").trim();
}

/**
 * "Add to playbook" for call transcripts (docs/V2_SPEC.md §C9). Wrap the transcript viewer:
 *   <AddToPlaybook transcriptId={t.id}><TranscriptViewer text={t.rawText} /></AddToPlaybook>
 * Selecting text inside shows a floating "Add to playbook" button; a header button lets keyboard / touch users paste a
 * quote instead. The server re-checks call visibility, that the quote really is in the transcript, and inherits the
 * call's restricted (MNPI) flag.
 */
export function AddToPlaybook({ transcriptId, children, className }: { transcriptId: string; children: React.ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [float, setFloat] = useState<{ top: number; left: number; picked: Picked } | null>(null);
  const [dialog, setDialog] = useState<Picked | null>(null);

  const onSelection = useCallback(() => {
    const root = rootRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return setFloat(null);
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return setFloat(null);
    const quote = selectedText(range, root);
    if (quote.length < 8) return setFloat(null);
    const rect = range.getBoundingClientRect();
    const meta = lineMeta(range.startContainer, root);
    setFloat({
      top: Math.max(8, rect.top - 44),
      left: Math.min(Math.max(8, rect.left + rect.width / 2 - 70), window.innerWidth - 150),
      picked: { quote: quote.slice(0, 1200), ...meta },
    });
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      clearTimeout(t);
      t = setTimeout(onSelection, 120);
    };
    const hide = () => setFloat(null);
    document.addEventListener("selectionchange", handler);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("selectionchange", handler);
      window.removeEventListener("scroll", hide, true);
    };
  }, [onSelection]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="min-w-0 text-[11px] text-muted">Select a line to clip it to the team playbook.</p>
        <Button variant="ghost" size="sm" onClick={() => setDialog({ quote: "", at: null, speaker: null })}>
          <BookmarkPlus /> Add clip
        </Button>
      </div>
      <div ref={rootRef} className="min-h-0 flex-1">
        {children}
      </div>
      {float ? (
        <div className="fixed z-40" style={{ top: float.top, left: float.left }}>
          <Button
            variant="primary"
            size="sm"
            onMouseDown={(e) => e.preventDefault() /* keep the selection */}
            onClick={() => {
              setDialog(float.picked);
              setFloat(null);
            }}
          >
            <BookmarkPlus /> Add to playbook
          </Button>
        </div>
      ) : null}
      {dialog ? <ClipDialog transcriptId={transcriptId} initial={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function ClipDialog({ transcriptId, initial, onClose }: { transcriptId: string; initial: Picked; onClose: () => void }) {
  const [quote, setQuote] = useState(initial.quote);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<PlaybookTag[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await addPlaybookClip({ transcriptId, quote, at: initial.at, speaker: initial.speaker, title, note: note || undefined, tags });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success("Clipped to the playbook.");
      window.getSelection()?.removeAllRanges();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to playbook</DialogTitle>
          <DialogDescription>
            {initial.speaker || initial.at ? `${initial.speaker ?? ""}${initial.speaker && initial.at ? " · " : ""}${initial.at ?? ""} — ` : ""}
            The exact words, so the next rep can use them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody>
            <div className="space-y-1.5">
              <Label htmlFor="clip-quote">Quote</Label>
              <Textarea
                id="clip-quote"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                rows={4}
                maxLength={1200}
                required
                placeholder="Paste or select the exact words from the transcript"
                className="font-display text-[15px] italic"
                aria-invalid={Boolean(errors.quote)}
              />
              {errors.quote ? <p className="text-xs text-critical">{errors.quote[0]}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clip-title">Title</Label>
              <Input id="clip-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required placeholder="e.g. Handling “we already have an ad stack”" aria-invalid={Boolean(errors.title)} />
              {errors.title ? <p className="text-xs text-critical">{errors.title[0]}</p> : null}
            </div>
            <TagPicker value={tags} onChange={setTags} />
            {errors.tags ? <p className="text-xs text-critical">{errors.tags[0]}</p> : null}
            <div className="space-y-1.5">
              <Label htmlFor="clip-note">Why it works (optional)</Label>
              <Textarea id="clip-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !tags.length || quote.trim().length < 8 || title.trim().length < 3}>
              {pending ? "Saving…" : "Add to playbook"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
