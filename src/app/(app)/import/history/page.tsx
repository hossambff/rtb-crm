import Link from "next/link";
import { notFound } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { BatchTable } from "@/components/import/batch-table";
import { can, requireUser } from "@/lib/rbac/server";
import { batchRowsFor } from "../rows";

export const metadata = { title: "Import history" };

export default async function ImportHistoryPage() {
  const user = await requireUser();
  if (!(await can(user, "import", "import"))) notFound();
  const batches = await batchRowsFor(user, 200);
  return (
    <>
      <PageHeader
        title="Import history"
        description="Every import batch with row-level results. Roll back restores updated fields and archives what the batch created."
        actions={
          <Button asChild variant="primary" size="sm">
            <Link href="/import">
              <Upload /> New import
            </Link>
          </Button>
        }
      />
      <BatchTable batches={batches} />
    </>
  );
}
