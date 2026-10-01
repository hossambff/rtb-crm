"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

type Line = { ts: string | null; speaker: string | null; text: string };

function parseLines(text: string): Line[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const m = l.match(/^(?:\[(\d{2}:\d{2}:\d{2})\]\s*)?(?:([^:]{1,60}):\s)?(.*)$/);
      const speaker = m?.[2] && !/[.!?]/.test(m[2]) ? m[2] : null;
      return { ts: m?.[1] ?? null, speaker, text: speaker ? (m?.[3] ?? l) : l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "") };
    });
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="rounded-sm bg-fg px-0.5 text-accent-inverse">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

export const lineId = (ts: string) => `t-${ts.replace(/:/g, "-")}`;

/** Transcript with speaker labels, timestamps (anchor targets for evidence links) and in-page search. */
export function TranscriptViewer({ text }: { text: string }) {
  const lines = useMemo(() => parseLines(text), [text]);
  const [q, setQ] = useState("");
  const query = q.trim();
  const shown = query ? lines.filter((l) => `${l.speaker ?? ""} ${l.text}`.toLowerCase().includes(query.toLowerCase())) : lines;
  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker).filter(Boolean))], [lines]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transcript" aria-label="Search transcript" className="h-8 pl-8" />
        </div>
        <p className="text-[11px] text-muted">
          {query ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}
          {speakers.length ? ` · ${speakers.length} speaker${speakers.length === 1 ? "" : "s"}: ${speakers.slice(0, 4).join(", ")}` : ""}
        </p>
      </div>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm leading-6">
        {shown.map((l, i) => (
          <li key={i} id={l.ts ? lineId(l.ts) : undefined} data-ts={l.ts ?? undefined} data-speaker={l.speaker ?? undefined} className="scroll-mt-24 target:rounded target:bg-surface-2">
            <div className="flex items-baseline gap-2">
              {l.ts ? <span className="shrink-0 font-mono text-[11px] text-muted tabular">{l.ts}</span> : null}
              {l.speaker ? <span className="text-xs font-medium text-fg">{highlight(l.speaker, query)}</span> : null}
            </div>
            <p data-clip-text className="text-body">
              {highlight(l.text, query)}
            </p>
          </li>
        ))}
        {!shown.length ? <li className="text-sm text-muted">No lines match “{query}”.</li> : null}
      </ol>
    </div>
  );
}
