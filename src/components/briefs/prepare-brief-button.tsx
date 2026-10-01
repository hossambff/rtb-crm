"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { prepareBriefNow } from "@/lib/briefs/actions";

export function PrepareBriefButton({ meetingId, refresh = false, variant = "primary" }: { meetingId: string; refresh?: boolean; variant?: "primary" | "secondary" | "ghost" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await prepareBriefNow({ meetingId });
          if (!r.ok) toast.error(r.error);
          else {
            toast.success(refresh ? "Brief refreshed." : "Brief ready.");
            router.refresh();
          }
        })
      }
    >
      {refresh ? <RefreshCw /> : <Sparkles />} {pending ? "Preparing…" : refresh ? "Refresh" : "Prepare brief"}
    </Button>
  );
}
