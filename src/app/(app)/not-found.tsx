import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Branded 404 inside the app shell (QA-09). */
export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-20 text-center">
      <SearchX className="size-8 text-muted" strokeWidth={1.25} aria-hidden />
      <h1 className="mt-4 font-display text-2xl text-fg">Not found</h1>
      <p className="mt-2 text-sm text-secondary">It may have been deleted or moved, or you don&apos;t have access to it.</p>
      <div className="mt-6">
        <Button asChild variant="primary">
          <Link href="/home">Back to My Day</Link>
        </Button>
      </div>
    </div>
  );
}
