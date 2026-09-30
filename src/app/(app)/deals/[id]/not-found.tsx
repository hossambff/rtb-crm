import Link from "next/link";
import { EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

export default function DealNotFound() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <EmptyState
        title="Deal not found"
        description="It may have been deleted, or you don't have access to it."
        action={
          <Button variant="secondary" asChild>
            <Link href="/pipelines">Back to pipelines</Link>
          </Button>
        }
      />
    </div>
  );
}
