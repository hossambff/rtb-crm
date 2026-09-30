import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { UserError } from "@/lib/actions";
import { getCurrentUser } from "@/lib/rbac/server";
import { granolaKeyInput, saveGranolaKeyFor, sameOrigin } from "@/lib/integrations/secrets";

export const dynamic = "force-dynamic";

/** Save + verify the signed-in user's Granola API key (D6). Body: { key }. */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  const parsed = granolaKeyInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your Granola API key." }, { status: 400 });
  try {
    const r = await saveGranolaKeyFor(user, parsed.data);
    revalidatePath("/settings");
    return NextResponse.json({ ok: true, warning: r.warning });
  } catch (e) {
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[granola] save failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
