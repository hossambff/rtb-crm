import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/rbac/server";
import { getRunDetail } from "@/lib/scout/queries";

/** Run progress for polling (steps without outputs; no secrets). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/scout/runs/[id]">) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const d = await getRunDetail(user, id);
  if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(
    {
      id,
      status: d.run.status,
      costCents: d.run.costCents,
      estimatedCostCents: d.run.estimatedCostCents,
      resultsCount: d.run.resultsCount,
      verifiedCount: d.run.verifiedCount,
      error: d.run.error,
      steps: d.steps,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
