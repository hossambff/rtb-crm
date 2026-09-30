import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";

export const metadata = { title: "Not found" };

/** Branded 404 for unknown URLs (M-26, QA-09) — replaces Next's unstyled default page. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-lg">
        <EmptyState
          title="Page not found"
          description="This page doesn't exist, was moved, or you don't have access to it."
          action={
            <Button variant="primary" asChild>
              <Link href="/home">Go to My Day</Link>
            </Button>
          }
        />
      </div>
    </main>
  );
}
