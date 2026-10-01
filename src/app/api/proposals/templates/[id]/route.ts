import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { DOCX_MIME } from "@/lib/proposals/docx/package";
import { attachmentDisposition } from "@/lib/proposals/docx/filename";
import { getTemplate, loadTemplateFile } from "@/lib/proposals/templates";
import { json, routeError, routeUser } from "@/lib/proposals/http";

/** Admin: download the original uploaded template (audited). */
export async function GET(_req: Request, ctx: RouteContext<"/api/proposals/templates/[id]">) {
  const user = await routeUser();
  if (user instanceof NextResponse) return user;
  try {
    await requireAdmin(user);
    const { id } = await ctx.params;
    const t = await getTemplate(id);
    if (!t) return json({ error: "Template not found." }, 404);
    const buf = await loadTemplateFile(t.id);
    await audit({ actorId: user.id, action: "proposal_template.download", entity: "proposal_template", entityId: t.id, after: { version: t.version, sha256: t.sha256 } });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": DOCX_MIME,
        "Content-Disposition": attachmentDisposition(t.fileName),
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return routeError("proposals.template_download", e);
  }
}
