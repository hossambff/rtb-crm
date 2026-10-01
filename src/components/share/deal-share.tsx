import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getCurrentUser } from "@/lib/rbac/server";
import { canShareDeal, shareableFields } from "@/lib/share/service";
import { ShareDealsButton } from "./share-dialog";

/**
 * Deal page slot (owner WS-E1): "Share with partner" (read-only link). Async server component; renders nothing when
 * the user can't share this deal (needs edit access; restricted deals never; not while impersonating).
 */
export async function DealShareButton({ dealId }: { dealId: string }) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return null;
  let data: { label: string; fields: Awaited<ReturnType<typeof shareableFields>> } | null = null;
  try {
    if (!(await canShareDeal(user, dealId))) return null;
    const [[d], fields] = await Promise.all([
      db
        .select({ name: s.deals.name, accountName: s.accounts.name, pipelineKey: s.pipelines.key })
        .from(s.deals)
        .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(eq(s.deals.id, dealId)),
      shareableFields(user),
    ]);
    if (d && fields.length) data = { label: `${d.accountName ?? d.name} — ${d.pipelineKey} status`, fields };
  } catch {
    data = null;
  }
  if (!data) return null;
  return <ShareDealsButton dealIds={[dealId]} scopeDealId={dealId} allowedFields={data.fields} defaultLabel={data.label} />;
}
