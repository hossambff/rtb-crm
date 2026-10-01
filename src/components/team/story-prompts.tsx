import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ColorTick } from "@/components/ui/badge";
import { PIPELINE_COLORS, VIZ_OTHER } from "@/lib/palette";
import type { StoryPrompt } from "@/lib/team/queries";

/** "Stories waiting for you" strip at the top of the feed. */
export function StoryPrompts({ prompts }: { prompts: StoryPrompt[] }) {
  if (!prompts.length) return null;
  return (
    <section aria-label="Stories to share" className="rounded-lg border border-border-strong bg-surface-1 p-4">
      <p className="font-display text-base text-fg">
        {prompts.length === 1 ? "A story is waiting for you" : `${prompts.length} stories are waiting for you`}
      </p>
      <p className="mt-0.5 text-xs text-muted">Drafts are ready — two minutes each.</p>
      <ul className="mt-3 divide-y divide-border">
        {prompts.map((p) => (
          <li key={p.dealId}>
            <Link href={`/team?share=${p.dealId}`} scroll={false} className="group flex items-center gap-3 py-2 text-sm">
              <ColorTick color={PIPELINE_COLORS[p.pipelineKey] ?? VIZ_OTHER} />
              <span className="min-w-0 flex-1 truncate text-body">
                <span className="text-muted">{p.status === "won" ? "Won" : "Lost"} · </span>
                {p.dealName}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-secondary group-hover:text-fg">
                Share <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
