"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startReview } from "@/lib/review/actions";
import type { ReviewScope } from "@/lib/review/queries";

export function StartReviewButton({ scope, count, limit }: { scope: ReviewScope; count: number; limit: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const n = Math.min(count, limit);
  return (
    <Button
      variant="primary"
      size="lg"
      disabled={pending || count === 0}
      onClick={() =>
        start(async () => {
          const res = await startReview({ pipelineKeys: scope.pipelineKeys, teamId: scope.teamId, ownerIds: scope.ownerIds });
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          router.push(`/review/${res.data.id}`);
        })
      }
    >
      <Play /> {pending ? "Starting…" : `Start review · ${n} deal${n === 1 ? "" : "s"}`}
    </Button>
  );
}
