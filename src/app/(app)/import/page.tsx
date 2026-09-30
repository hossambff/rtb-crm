import Link from "next/link";
import { forbidden } from "next/navigation";
import { History } from "lucide-react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { BatchTable } from "@/components/import/batch-table";
import { ImportWizard } from "@/components/import/import-wizard";
import { batchRowsFor } from "./rows";
import { can, requireUser } from "@/lib/rbac/server";

export const metadata = { title: "Import" };

export default async function ImportPage() {
  const user = await requireUser();
  if (!(await can(user, "import", "import"))) forbidden();
  const [pipelines, batches] = await Promise.all([
    db.select({ key: s.pipelines.key, name: s.pipelines.name }).from(s.pipelines).where(eq(s.pipelines.active, true)).orderBy(asc(s.pipelines.sortOrder)),
    batchRowsFor(user, 5),
  ]);
  return (
    <>
      <PageHeader
        title="Import"
        description="Bring spreadsheets into the CRM: auto-mapped columns, MUU parsing, status → stage, owner splits, dedupe and one-click rollback."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/import/history">
              <History /> Import history
            </Link>
          </Button>
        }
      />
      <ImportWizard pipelines={pipelines} canSaveTemplates />
      <section className="mt-10">
        <h2 className="mb-3 font-display text-lg text-fg">Recent imports</h2>
        <BatchTable batches={batches} />
      </section>
    </>
  );
}
