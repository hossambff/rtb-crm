"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshOneOnOne } from "@/lib/briefs/one-on-one-actions";
import { cn } from "@/lib/utils";

export function RefreshBriefButton({ repId }: { repId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await refreshOneOnOne({ repId });
          if (!res.ok) toast.error(res.error);
          else {
            toast.success(res.data.engine === "heuristic" ? "Brief refreshed." : "Brief refreshed with Copilot.");
            router.refresh();
          }
        })
      }
    >
      <RefreshCw className={cn(pending && "animate-spin motion-reduce:animate-none")} /> {pending ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
