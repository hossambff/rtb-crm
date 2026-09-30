import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Rendered (inside the app shell) with HTTP 403 whenever a page or segment layout calls `forbidden()` (QA-09). */
export default function Forbidden() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-20 text-center">
      <ShieldOff className="size-8 text-muted" strokeWidth={1.25} aria-hidden />
      <h1 className="mt-4 font-display text-2xl text-fg">No access</h1>
      <p className="mt-2 text-sm text-secondary">
        This page or record doesn&apos;t exist, or your role doesn&apos;t include it. If you need it for your work, ask an admin to update your
        permissions.
      </p>
      <div className="mt-6 flex gap-2">
        <Button asChild variant="primary">
          <Link href="/home">Back to My Day</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/pipelines">Pipelines</Link>
        </Button>
      </div>
    </div>
  );
}
