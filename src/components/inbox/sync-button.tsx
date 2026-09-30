"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncInboxNow } from "@/lib/gmail/actions";
import { cn } from "@/lib/utils";

export function SyncButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          const r = await syncInboxNow({});
          if (!r.ok) {
            toast.error(r.error);
            return;
          }
          const d = r.data;
          toast.success(
            d.ingested
              ? `Synced ${d.ingested} new message${d.ingested === 1 ? "" : "s"}${d.analyzed ? `, analyzed ${d.analyzed}` : ""}.`
              : `Up to date${d.done ? "" : " — more history is still loading"}.`,
          );
          router.refresh();
        })
      }
    >
      <RefreshCw className={cn(pending && "animate-spin")} /> {pending ? "Syncing…" : "Sync now"}
    </Button>
  );
}
