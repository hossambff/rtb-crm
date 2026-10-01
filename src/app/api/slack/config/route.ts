import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError } from "@/lib/actions";
import { sameOrigin } from "@/lib/integrations/secrets";
import { ForbiddenError, getCurrentUser } from "@/lib/rbac/server";
import { credentialsInput, saveSlackCredentials } from "@/lib/slack/admin";

export const dynamic = "force-dynamic";

/**
 * Admin-only: save / rotate the Slack bot token + signing secret. A route handler (not a server action) so the secret
 * values never pass through server-function argument logging. Same-origin + session + admin:configure.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  const parsed = credentialsInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the highlighted fields.", fieldErrors: z.flattenError(parsed.error).fieldErrors }, { status: 400 });
  }
  try {
    const r = await saveSlackCredentials(user, parsed.data);
    revalidatePath("/admin/slack");
    return NextResponse.json({ ok: true, teamName: r.teamName });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[slack] save config failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
