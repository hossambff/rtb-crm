import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError } from "@/lib/actions";
import { ForbiddenError, getCurrentUser } from "@/lib/rbac/server";
import { saveZoomConfigFor, sameOrigin, zoomConfigInput } from "@/lib/integrations/secrets";

export const dynamic = "force-dynamic";

/** Admin-only: save the org Zoom connection. Body: { accountId, clientId?, clientSecret?, webhookSecret? }. */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  const parsed = zoomConfigInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the highlighted fields.", fieldErrors: z.flattenError(parsed.error).fieldErrors }, { status: 400 });
  }
  try {
    await saveZoomConfigFor(user, parsed.data);
    revalidatePath("/settings");
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[zoom] save failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
