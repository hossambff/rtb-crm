"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createTaskFromCommitment, reanalyzeMessage, undoEmailTask } from "@/lib/gmail/actions";
import { fmtDate } from "@/lib/format";
import type { Commitment } from "@/lib/gmail/analysis-core";

export function CommitmentList({
  messageId,
  commitments,
  taskIds,
  taskStatus,
  canAct,
}: {
  messageId: string;
  commitments: Commitment[];
  taskIds: Record<string, string>;
  taskStatus: Record<string, string>;
  canAct: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!commitments.length) return null;
  return (
    <ul className="space-y-2">
      {commitments.map((c, i) => {
        const taskId = taskIds[String(i)];
        const status = taskId ? taskStatus[taskId] : undefined;
        return (
          <li key={i} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-body">
                  <Badge className="mr-1.5">{c.by === "us" ? "We owe" : "They owe"}</Badge>
                  {c.text}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {c.person ? `${c.person} · ` : ""}
                  {c.due ? `due ${fmtDate(c.due, "EEE d MMM")}` : "no date"}
                </p>
                <blockquote className="mt-1 border-l border-border-strong pl-2 text-xs italic text-secondary">“{c.evidence}”</blockquote>
              </div>
              {canAct ? (
                taskId && status !== "cancelled" ? (
                  <div className="flex items-center gap-1">
                    <span className="inline-flex items-center gap-1 text-xs text-secondary">
                      <Check className="size-3.5 text-good" aria-hidden /> Task created
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Undo task"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const r = await undoEmailTask({ taskId });
                          if (!r.ok) toast.error(r.error);
                          else {
                            toast.success("Task cancelled.");
                            router.refresh();
                          }
                        })
                      }
                    >
                      <RotateCcw />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await createTaskFromCommitment({ messageId, index: i });
                        if (!r.ok) toast.error(r.error);
                        else {
                          toast.success("Task created.");
                          router.refresh();
                        }
                      })
                    }
                  >
                    <Plus /> Create task
                  </Button>
                )
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ReanalyzeButton({ messageId }: { messageId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await reanalyzeMessage({ messageId });
          if (!r.ok) toast.error(r.error);
          else {
            toast.success(`Analyzed (${r.data.engine === "heuristic" ? "heuristic" : "AI"}).`);
            router.refresh();
          }
        })
      }
    >
      <Sparkles /> {pending ? "Analyzing…" : "Analyze"}
    </Button>
  );
}
