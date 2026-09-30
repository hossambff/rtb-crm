"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runSweepNow } from "@/lib/alerts/actions";

/** Admin-only: run the Nothing Slips sweep immediately. */
export function RunSweepButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await runSweepNow({});
          if (!res.ok) return void toast.error(res.error);
          const s = res.data;
          toast.success(`Sweep done in ${(s.ms / 1000).toFixed(1)}s`, {
            description: `${s.evaluated.length} rules · ${s.created} new · ${s.resolved} auto-resolved · ${s.escalated} escalated${s.failed.length ? ` · ${s.failed.length} failed` : ""}`,
          });
          router.refresh();
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : undefined} /> {pending ? "Sweeping…" : "Run sweep now"}
    </Button>
  );
}
